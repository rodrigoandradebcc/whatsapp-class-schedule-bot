import * as wppconnect from "@wppconnect-team/wppconnect";
import type { Whatsapp } from "@wppconnect-team/wppconnect";
import { schedule, ScheduledTask } from "node-cron";

// ── CONFIGURAÇÃO DE CRONS E TIMEZONE ────────────────────────────────────────────
const POLL_CRON = "*/2 * * * * *"; // para checagem de votos em teste
const TZ = "America/Belem";

// ── CONSTANTES DA ENQUETE ───────────────────────────────────────────────────────

// GRUPO DE TESTE
// const GROUP_ID = "120363419276384559@g.us";

// GRUPO REAL CT SABOIA
const GROUP_ID = "559182178645-1552489380@g.us";

const MORNING_OPTIONS = ["6h", "7h", "8h", "9h"];
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
// const CAPACITY = 1; // máximo de votos por opção

// ── TIPAGENS DE ESTADO ─────────────────────────────────────────────────────────
interface State {
  fullNotified: Set<string>;
  userNotified: Set<string>;
}

interface Vote {
  selectedOptions: Array<{ name?: string }>;
  timestamp: number;
  sender: { _serialized: string };
}

// ── FUNÇÕES AUXILIARES ──────────────────────────────────────────────────────────

/** inicializa e retorna o client WPPConnect */
async function initClient(): Promise<Whatsapp> {
  return wppconnect.create({
    session: "POLL_BOT",
    headless: true,
    useChrome: false,
    disableWelcome: true,
    updatesLog: true,
    tokenStore: "file",
    browserArgs: ["--no-sandbox"],
    autoClose: 0,
    puppeteerOptions: { args: ["--no-sandbox"] },
    catchQR: (base64Qrimg, asciiQR, attempts, urlCode) => {
      console.clear();
      console.log("📲 Escaneie o QR Code abaixo para logar no WhatsApp:");
      console.log(asciiQR);
      console.log(`🔗 urlCode: ${urlCode}`);
    },
    statusFind: (statusSession, session) => {
      console.log("📡 Status da sessão:", statusSession);
      console.log("📌 Nome da sessão:", session);
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

/** conta votos por opção */
function countVotesByName(votes: Vote[]): Record<string, number> {
  return votes.reduce((acc, vote) => {
    for (const opt of vote.selectedOptions ?? []) {
      if (!opt || !opt.name) {
        console.warn("voto sem name:", vote);
        continue;
      }

      const key = opt.name ?? "Sem nome";
      acc[key] = (acc[key] || 0) + 1;
    }
    return acc;
  }, {} as Record<string, number>);
}

/** retorna último votante para uma opção */
function getLastVoterForOption(votes: Vote[], opt: string): string | null {
  const filtered = votes.filter((v) =>
    v.selectedOptions.some((o) => o.name === opt)
  );
  filtered.sort((a, b) => a.timestamp - b.timestamp);
  return filtered.length
    ? filtered[filtered.length - 1].sender._serialized
    : null;
}

/** notifica grupo que opção atingiu a capacidade */
async function notifyGroupCapacityReached(
  client: Whatsapp,
  opt: string
): Promise<void> {
  await client.sendText(
    GROUP_ID,
    `🚫 O horário de *${opt}* atingiu o limite de ${CAPACITY} participantes e foi fechado.`
  );
}

/** notifica grupo que opção reabriu vaga */
async function notifyGroupSlotOpened(
  client: Whatsapp,
  opt: string
): Promise<void> {
  await client.sendText(
    GROUP_ID,
    `🔓 O horário de *${opt}* agora tem vaga novamente!`
  );
}

/** notifica usuário que votou após fechamento */
async function notifyUserSlotClosed(
  client: Whatsapp,
  opt: string,
  userId: string
): Promise<void> {
  const contact = await client.getContact(userId);
  const name = contact.pushname || contact.formattedName || "Participante";
  await client.sendText(
    GROUP_ID,
    `${name}, o horário de *${opt}* está fechado. Por favor, escolha outro.`
  );
}

/** checa votos e dispara notificações */
async function checkVotes(
  client: Whatsapp,
  pollId: string,
  state: State
): Promise<void> {
  try {
    const { votes } = await client.getVotes(pollId);
    console.log("DEBUG getVotes:", votes);
    const counts = countVotesByName(votes as Vote[]);

    // reabertura de vagas
    state.fullNotified.forEach((opt) => {
      if ((counts[opt] || 0) < CAPACITY) {
        notifyGroupSlotOpened(client, opt);
        state.fullNotified.delete(opt);
        state.userNotified.forEach((key) => {
          if (key.startsWith(`${opt}:`)) state.userNotified.delete(key);
        });
      }
    });

    // fechamento e votos extras
    Object.entries(counts).forEach(([opt, cnt]) => {
      if (cnt === CAPACITY && !state.fullNotified.has(opt)) {
        notifyGroupCapacityReached(client, opt);
        state.fullNotified.add(opt);
      }
      if (cnt > CAPACITY) {
        const extra = getLastVoterForOption(votes as Vote[], opt);
        const key = `${opt}:${extra}`;
        if (
          extra &&
          state.fullNotified.has(opt) &&
          !state.userNotified.has(key)
        ) {
          notifyUserSlotClosed(client, opt, extra);
          state.userNotified.add(key);
        }
      }
    });
  } catch (err) {
    console.error("Erro em checkVotes:", err);
  }
}

/** lista todos os grupos */
async function logAllGroupIds(client: Whatsapp): Promise<void> {
  const groupChats = await client.listChats();
  console.log("📋 Grupos ativos:");
  groupChats.forEach((chat) => {
    console.log(`• ${chat.name} — ID: ${chat.id._serialized}`);
  });
}

// ── MAIN ────────────────────────────────────────────────────────────────────────
(async () => {
  const client = await initClient();
  await logAllGroupIds(client);

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
  let morningJob: ScheduledTask;
  let afternoonPollId: string;
  let afternoonJob: ScheduledTask;
  let saturdayPollId: string;
  let saturdayJob: ScheduledTask;

  /** reseta e inicia enquete da manhã */
  async function resetMorningPoll(): Promise<void> {
    morningJob?.stop();
    stateMorning.fullNotified.clear();
    stateMorning.userNotified.clear();
    const question = buildQuestionForOffset(1);
    const poll = await client.sendPollMessage(
      GROUP_ID,
      question,
      MORNING_OPTIONS,
      { selectableCount: 1 }
    );
    morningPollId = poll.id;
    morningJob = schedule(
      POLL_CRON,
      () => checkVotes(client, morningPollId, stateMorning),
      { timezone: TZ }
    );
  }

  async function resetSaturdayPoll(): Promise<void> {
    saturdayJob?.stop();
    stateSaturday.fullNotified.clear();
    stateSaturday.userNotified.clear();
    const question = buildQuestionForOffset(1); // offset 1: pergunta para sábado
    const poll = await client.sendPollMessage(
      GROUP_ID,
      question,
      SATURDAY_OPTIONS,
      { selectableCount: 1 }
    );
    saturdayPollId = poll.id;
    saturdayJob = schedule(
      POLL_CRON,
      () => checkVotes(client, saturdayPollId, stateSaturday),
      { timezone: TZ }
    );
  }

  /** reseta e inicia enquete da tarde/noite */
  async function resetAfternoonPoll(): Promise<void> {
    afternoonJob?.stop();
    stateAfternoon.fullNotified.clear();
    stateAfternoon.userNotified.clear();
    const question = buildQuestionForOffset(0);
    const poll = await client.sendPollMessage(
      GROUP_ID,
      question,
      AFTERNOON_AND_EVENING_OPTIONS,
      { selectableCount: 1 }
    );
    afternoonPollId = poll.id;
    afternoonJob = schedule(
      POLL_CRON,
      () => checkVotes(client, afternoonPollId, stateAfternoon),
      { timezone: TZ }
    );
  }

  // Agendamento da enquete da manhã: 21:00 de domingo(0) a sexta(5)
  schedule(
    "0 19 * * 0-4",
    // "* * * * *",
    () => {
      resetMorningPoll().catch(console.error);
    },
    { timezone: TZ }
  );

  // Agendamento da enquete da tarde/noite para testes: a cada minuto
  schedule(
    // "* * * * *",
    "0 9 * * 1-5",
    () => {
      resetAfternoonPoll().catch(console.error);
    },
    { timezone: TZ }
  );

  schedule(
    "0 19 * * 5",
    // "* * * * *",
    () => {
      resetSaturdayPoll().catch(console.error);
    },
    { timezone: TZ }
  );

  // schedule(
  //   "* * * * *", // todos os dias às 12:00
  //   async () => {
  //     try {
  //       await client.sendText(GROUP_ID, "🤖 Bot CT.");
  //     } catch (error) {
  //       console.error("Erro ao enviar mensagem de teste:", error);
  //     }
  //   },
  //   { timezone: TZ }
  // );

  // Para voltar ao cron real (09:00 de seg–sáb), comente a linha acima e use:
  // schedule("0 9 * * 1-6", () => { resetAfternoonPoll().catch(console.error); }, { timezone: TZ });
})();
