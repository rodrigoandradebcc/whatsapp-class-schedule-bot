import * as wppconnect from "@wppconnect-team/wppconnect";
import type { Whatsapp } from "@wppconnect-team/wppconnect";
import { schedule, ScheduledTask } from "node-cron";

// ── CONFIGURAÇÃO DE CRONS E TIMEZONE ────────────────────────────────────────────
const DAILY_CRON = "* * * * *"; // testes: todo minuto
const POLL_CRON = "*/2 * * * * *"; // testes: a cada 2 segundos
const TZ = "America/Belem";

// ── CONSTANTES DA ENQUETE ───────────────────────────────────────────────────────
const GROUP_ID = "120363419276384559@g.us";
const OPTIONS = ["6h", "7h", "8h", "9h"];
const CAPACITY = 1; // máximo de votos por opção

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
  return wppconnect.create(
    "POLL_BOT",
    undefined,
    undefined,
    undefined,
    undefined,
    { puppeteerOptions: { headless: false } }
  );
}

/** gera a pergunta com data de amanhã em DD/MM/YYYY */
function buildQuestion(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `Qual horário para o treino de ${dd}/${mm}/${yyyy}?`;
}

/** envia a enquete e devolve o pollId */
async function sendPoll(client: Whatsapp): Promise<string> {
  const question = buildQuestion();
  const poll = await client.sendPollMessage(GROUP_ID, question, OPTIONS, {
    selectableCount: 1,
  });
  return poll.id;
}

/** conta votos por opção */
function countVotesByName(votes: Vote[]): Record<string, number> {
  return votes.reduce((acc, vote) => {
    vote.selectedOptions.forEach((opt) => {
      if (opt.name) acc[opt.name] = (acc[opt.name] || 0) + 1;
    });
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
    const counts = countVotesByName(votes as Vote[]);

    // reabertura
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
    (Object.entries(counts) as [string, number][]).forEach(([opt, cnt]) => {
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

// ── MAIN ────────────────────────────────────────────────────────────────────────
(async () => {
  const client = await initClient();
  const state: State = { fullNotified: new Set(), userNotified: new Set() };

  let pollId: string;
  let voteJob: ScheduledTask;

  async function resetQuiz(): Promise<void> {
    state.fullNotified.clear();
    state.userNotified.clear();
    voteJob?.stop();
    pollId = await sendPoll(client);
    voteJob = schedule(POLL_CRON, () => checkVotes(client, pollId, state), {
      timezone: TZ,
    });
  }

  await resetQuiz();
  schedule(DAILY_CRON, resetQuiz, { timezone: TZ });
})();
