import * as wppconnect from "@wppconnect-team/wppconnect";
import type { Whatsapp } from "@wppconnect-team/wppconnect";
import { schedule, ScheduledTask } from "node-cron";

// ── CONFIGURAÇÃO DE TIMEZONE ───────────────────────────────────────────────────
const TZ = "America/Belem";
const SEND_POLL_TIMEOUT_MS = 60000;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;

// ── CONSTANTES DA ENQUETE ───────────────────────────────────────────────────────

const GROUP_ID = "559182178645-1552489380@g.us";

const MORNING_OPTIONS = ["6h", "7h", "8h", "9h", "10h", "11h"];
const AFTERNOON_AND_EVENING_OPTIONS = [
  "12h",
  "13h",
  "14h",
  "15h",
  "16h",
  "17h",
  "18h",
  "19h",
  "20h",
  "21h",
  "Off",
];
const SATURDAY_OPTIONS = ["7h", "8h", "9h", "10h", "11h", "12h", "13h", "14h"];

const CAPACITY = 16; // máximo de votos por opção

// ── TIPAGENS DE ESTADO ─────────────────────────────────────────────────────────
interface State {
  fullNotified: Set<string>;
  userNotified: Set<string>;
}

interface Vote {
  selectedOptions: Array<{ name?: string }>;
  timestamp: number;
  sender: { _serialized: string; user: string };
}

let client: Whatsapp;

// Monitoramento desativado: helper mantido apenas para referência futura.
// async function logDuration<T>(_: string, fn: () => Promise<T>): Promise<T> {
//   return fn();
// }
// ── FUNÇÕES AUXILIARES ──────────────────────────────────────────────────────────

/** inicializa e retorna o client WPPConnect */
async function initClient(): Promise<Whatsapp> {
  return wppconnect.create({
    session: "POLL_BOT",
    headless: true,
    useChrome: false,
    disableWelcome: true,
    whatsappVersion: "",
    tokenStore: "file",
    autoClose: 0,
    // Disable device sync timeout too; otherwise WPPConnect will still auto-close.
    deviceSyncTimeout: 0,
    puppeteerOptions: {
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      protocolTimeout: 0,
      timeout: 0,
    },
    catchQR: (base64Qrimg, asciiQR, attempts, urlCode) => {
      console.clear();
      console.log("📲 Escaneie o QR Code abaixo para logar no WhatsApp:");
      console.log(asciiQR);
      console.log(`🔗 urlCode: ${urlCode}`);
    },
  });
}

/** gera a pergunta com data no formato DD/MM/YYYY, com offset de dias */
function buildQuestionForOffset(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `Qual seu horário para o treino de ${dd}/${mm}/${yyyy}?`;
}

// /** conta votos por opção */
// function countVotesByName(votes: Vote[]): Record<string, number> {
//   return votes.reduce(
//     (acc, vote) => {
//       const fallbackName = `[sem nome] - ${vote.sender.user}`;
//       for (const opt of vote.selectedOptions ?? []) {
//         if (!opt || !opt.name) {
//           continue;
//         }
//
//         const key = opt.name ?? fallbackName;
//         acc[key] = (acc[key] || 0) + 1;
//       }
//       return acc;
//     },
//     {} as Record<string, number>,
//   );
// }
//
// /** retorna último votante para uma opção */
// function getLastVoterForOption(votes: Vote[], opt: string): string | null {
//   const filtered = votes.filter((v) =>
//     v.selectedOptions.some((o) => o && o.name === opt),
//   );
//   filtered.sort((a, b) => a.timestamp - b.timestamp);
//   return filtered.length ? filtered[filtered.length - 1].sender.user : null;
// }
//
// function isChatNotFoundError(err: unknown): boolean {
//   if (!err || typeof err !== "object") return false;
//   const anyErr = err as { code?: string; message?: string };
//   return (
//     anyErr.code === "chat_not_found" ||
//     (anyErr.message ?? "").includes("Chat not found")
//   );
// }
//
// function isMessageNotFoundError(err: unknown): boolean {
//   if (!err || typeof err !== "object") return false;
//   const anyErr = err as { code?: string; message?: string };
//   return (
//     anyErr.code === "msg_not_found" ||
//     ((anyErr.message ?? "").includes("Message") &&
//       (anyErr.message ?? "").includes("not found"))
//   );
// }

async function ensureGroupChatLoaded(client: Whatsapp): Promise<void> {
  try {
    await client.getChatById(GROUP_ID);
  } catch (err) {
    console.error("Falha ao carregar chat do grupo:", err);
  }
}

async function waitForClientReady(
  client: Whatsapp,
  timeoutMs = 120000,
): Promise<void> {
  const alreadyConnected = await client.isConnected().catch(() => false);
  if (alreadyConnected) return;

  await new Promise<void>((resolve, reject) => {
    let disposer: { dispose: () => void } | undefined;
    const timeout = setTimeout(() => {
      disposer?.dispose();
      reject(
        new Error(
          `Timeout aguardando WhatsApp ficar CONNECTED (${timeoutMs}ms)`,
        ),
      );
    }, timeoutMs);

    disposer = client.onStateChange((state) => {
      if (state === "CONNECTED") {
        clearTimeout(timeout);
        disposer?.dispose();
        resolve();
      }
    });
  });
}

async function ensureClientReady(
  client: Whatsapp,
  context: string,
): Promise<boolean> {
  try {
    await waitForClientReady(client);
    return true;
  } catch (err) {
    console.error(`❌ ${context}: WhatsApp não conectou a tempo`, err);
    return false;
  }
}

function isContextDestroyedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = (err as { message?: string }).message ?? "";
  return (
    msg.includes("Execution context was destroyed") ||
    msg.includes("Session closed") ||
    msg.includes("Target closed") ||
    msg.includes("Protocol error")
  );
}

async function sendPoll(
  client: Whatsapp,
  question: string,
  options: string[],
  context: string,
) {
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const poll = await Promise.race([
        client.sendPollMessage(GROUP_ID, question, options, {
          selectableCount: 1,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `${context}: timeout enviando enquete (${Math.round(
                    SEND_POLL_TIMEOUT_MS / 1000,
                  )}s) para ${GROUP_ID}`,
                ),
              ),
            SEND_POLL_TIMEOUT_MS,
          ),
        ),
      ]);
      if (!poll || !poll.id) {
        throw new Error(`${context}: resposta da enquete sem id`);
      }
      return poll;
    } catch (err) {
      if (isContextDestroyedError(err) && attempt < RETRY_ATTEMPTS) {
        console.warn(
          `⚠️ ${context}: contexto destruído (tentativa ${attempt}/${RETRY_ATTEMPTS}), aguardando reconexão...`,
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        await ensureClientReady(client, `${context} retry ${attempt}`);
        await ensureGroupChatLoaded(client);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${context}: todas as ${RETRY_ATTEMPTS} tentativas falharam`);
}
// /** notifica grupo que opção atingiu a capacidade */
// async function notifyGroupCapacityReached(
//   client: Whatsapp,
//   opt: string,
// ): Promise<void> {
//   await client.sendText(
//     GROUP_ID,
//     `🚫 O horário de *${opt}* atingiu o limite de ${CAPACITY} participantes e foi fechado.`,
//   );
// }

// /** notifica grupo que opção reabriu vaga */
// async function notifyGroupSlotOpened(
//   client: Whatsapp,
//   opt: string,
// ): Promise<void> {
//   await client.sendText(
//     GROUP_ID,
//     `🔓 O horário de *${opt}* agora tem vaga novamente!`,
//   );
// }

// /** notifica usuário que votou após fechamento */
// async function notifyUserSlotClosed(
//   client: Whatsapp,
//   opt: string,
//   userId: string,
// ): Promise<void> {
//   const contact = await client.getContact(userId);
//   const name = contact.pushname || contact.formattedName || userId;
//   await client.sendText(
//     GROUP_ID,
//     `${name}, o horário de *${opt}* está fechado. Por favor, escolha outro.`,
//   );
// }

/** checa votos e dispara notificações */
// async function checkVotes(
//   client: Whatsapp,
//   pollId: string,
//   state: State,
// ): Promise<void> {
//   try {
//     await ensureGroupChatLoaded(client);
//     let votesResult;
//     try {
//       votesResult = await logDuration(`getVotes(${pollId})`, () =>
//         client.getVotes(pollId),
//       );
//     } catch (err) {
//       if (isMessageNotFoundError(err)) {
//         await new Promise((resolve) => setTimeout(resolve, 3000));
//         await ensureGroupChatLoaded(client);
//         try {
//           votesResult = await logDuration(`getVotes(${pollId}) [retry]`, () =>
//             client.getVotes(pollId),
//           );
//         } catch (retryErr) {
//           if (isMessageNotFoundError(retryErr)) return;
//           if (!isChatNotFoundError(retryErr)) throw retryErr;
//         }
//       } else {
//         if (!isChatNotFoundError(err)) throw err;
//         await ensureGroupChatLoaded(client);
//         votesResult = await logDuration(`getVotes(${pollId}) [retry]`, () =>
//           client.getVotes(pollId),
//         );
//       }
//     }
//     if (!votesResult) return;
//     // const { votes } = votesResult;
//     // const counts = countVotesByName(votes as Vote[]);

//     // // reabertura de vagas
//     // state.fullNotified.forEach((opt) => {
//     //   if ((counts[opt] || 0) < CAPACITY) {
//     //     notifyGroupSlotOpened(client, opt);
//     //     state.fullNotified.delete(opt);
//     //     state.userNotified.forEach((key) => {
//     //       if (key.startsWith(`${opt}:`)) state.userNotified.delete(key);
//     //     });
//     //   }
//     // });

//     // // fechamento e votos extras
//     // Object.entries(counts).forEach(([opt, cnt]) => {
//     //   if (cnt === CAPACITY && !state.fullNotified.has(opt)) {
//     //     notifyGroupCapacityReached(client, opt);
//     //     state.fullNotified.add(opt);
//     //   }
//     //   if (cnt > CAPACITY) {
//     //     const extra = getLastVoterForOption(votes as Vote[], opt);
//     //     const key = `${opt}:${extra}`;
//     //     if (
//     //       extra &&
//     //       state.fullNotified.has(opt) &&
//     //       !state.userNotified.has(key)
//     //     ) {
//     //       notifyUserSlotClosed(client, opt, extra);
//     //       state.userNotified.add(key);
//     //     }
//     //   }
//     // });
//   } catch (err) {
//     console.error("Erro em checkVotes:", err);
//   }
// }

// ── MAIN ────────────────────────────────────────────────────────────────────────
// ── MAIN ────────────────────────────────────────────────────────────────────────
(async () => {
  client = await initClient();
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled Rejection:", reason);
  });

  process.on("uncaughtException", (err) => {
    console.error("Uncaught Exception:", err);
  });
  await waitForClientReady(client);
  const stateMorning: State = {
    fullNotified: new Set(),
    userNotified: new Set(),
  };
  const stateAfternoon: State = {
    fullNotified: new Set(),
    userNotified: new Set(),
  };
  const stateSaturday: State = {
    fullNotified: new Set(),
    userNotified: new Set(),
  };

  let morningPollId: string;
  let morningJob: ScheduledTask | undefined;
  let afternoonPollId: string;
  let afternoonJob: ScheduledTask | undefined;
  let saturdayPollId: string;
  let saturdayJob: ScheduledTask | undefined;

  /** reseta e inicia enquete da manhã */
  async function resetMorningPoll(): Promise<void> {
    morningJob?.stop();
    stateMorning.fullNotified.clear();
    stateMorning.userNotified.clear();
    if (!(await ensureClientReady(client, "resetMorningPoll"))) return;
    await ensureGroupChatLoaded(client);
    const question = buildQuestionForOffset(1);
    const poll = await sendPoll(
      client,
      question,
      MORNING_OPTIONS,
      "resetMorningPoll",
    );
    morningPollId = poll.id;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  async function resetSaturdayPoll(): Promise<void> {
    saturdayJob?.stop();
    stateSaturday.fullNotified.clear();
    stateSaturday.userNotified.clear();
    if (!(await ensureClientReady(client, "resetSaturdayPoll"))) return;
    await ensureGroupChatLoaded(client);
    const question = buildQuestionForOffset(1); // offset 1: pergunta para sábado
    const poll = await sendPoll(
      client,
      question,
      SATURDAY_OPTIONS,
      "resetSaturdayPoll",
    );
    saturdayPollId = poll.id;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  /** reseta e inicia enquete da tarde/noite */
  async function resetAfternoonPoll(): Promise<void> {
    afternoonJob?.stop();
    stateAfternoon.fullNotified.clear();
    stateAfternoon.userNotified.clear();
    if (!(await ensureClientReady(client, "resetAfternoonPoll"))) return;
    await ensureGroupChatLoaded(client);
    const question = buildQuestionForOffset(0);
    const poll = await sendPoll(
      client,
      question,
      AFTERNOON_AND_EVENING_OPTIONS,
      "resetAfternoonPoll",
    );
    afternoonPollId = poll.id;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  // Agendamento da enquete da manhã: 19:00 de domingo(0) a quinta(4)
  schedule(
    "0 19 * * 0-4",
    // "*/1 * * * *",
    () => {
      resetMorningPoll().catch(console.error);
    },
    { timezone: TZ },
  );

  // Agendamento da enquete da tarde/noite: 09:00 de segunda(1) a sexta(5)
  schedule(
    "0 9 * * 1-5",
    // "*/1 * * * *",
    () => {
      resetAfternoonPoll().catch(console.error);
    },
    { timezone: TZ },
  );

  schedule(
    "0 19 * * 5",
    () => {
      resetSaturdayPoll().catch(console.error);
    },
    { timezone: TZ },
  );
})();
