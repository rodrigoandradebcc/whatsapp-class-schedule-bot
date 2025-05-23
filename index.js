// index.js
const wppconnect = require("@wppconnect-team/wppconnect");
const cron = require("node-cron");

//
// ── CONFIGURAÇÃO DE CRONS E TIMEZONE ────────────────────────────────────────────
// Para testes rápidos, use:
//   const DAILY_CRON = "* * * * *";      // todo minuto
//   const POLL_CRON  = "*/2 * * * * *";  // a cada 2 segundos
// Quando estiver tudo certo, volte para:
//   const DAILY_CRON = "0 15 23 * * *";  // todo dia às 23:15:00
//   const POLL_CRON  = "*/5 * * * * *";  // a cada 5 segundos
const DAILY_CRON = "* * * * *"; // todo minuto (testes)
const POLL_CRON = "*/2 * * * * *"; // a cada 5 segundos
const TZ = "America/Belem";

//
// ── CONSTANTES DA ENQUETE ───────────────────────────────────────────────────────
const GROUP_ID = "120363419276384559@g.us";
const OPTIONS = ["6h", "7h", "8h", "9h"];
const CAPACITY = 1;

//
// ── FUNÇÕES AUXILIARES ──────────────────────────────────────────────────────────
async function initClient() {
  return wppconnect.create({
    session: "POLL_BOT",
    headless: false,
    useChrome: false,
    multiDevice: true,
    qrTimeout: 0,
  });
}

// gera a pergunta com a data de amanhã em DD/MM/YYYY
function buildQuestion() {
  const amanha = new Date();
  amanha.setDate(amanha.getDate() + 1);
  const dia = String(amanha.getDate()).padStart(2, "0");
  const mes = String(amanha.getMonth() + 1).padStart(2, "0");
  const ano = amanha.getFullYear();
  return `Qual horário para o treino de ${dia}/${mes}/${ano}?`;
}

// envia enquete usando a pergunta dinâmica
async function sendPoll(client) {
  const question = buildQuestion();
  const poll = await client.sendPollMessage(GROUP_ID, question, OPTIONS, {
    selectableCount: 1,
  });
  const pollId = poll.id ?? poll.messageId;
  console.log("✅ Enquete enviada:", question, "→ pollId =", pollId);
  return pollId;
}

function countVotesByName(votes) {
  return votes.reduce((acc, { selectedOptions }) => {
    selectedOptions.forEach((e) => {
      if (e?.name) acc[e.name] = (acc[e.name] || 0) + 1;
    });
    return acc;
  }, {});
}

function getLastVoterForOption(votes, optionName) {
  const arr = votes
    .filter((v) => v.selectedOptions.some((e) => e?.name === optionName))
    .sort((a, b) => a.timestamp - b.timestamp);
  return arr.length ? arr[arr.length - 1].sender._serialized : null;
}

async function notifyGroupCapacityReached(client, opt) {
  await client.sendText(
    GROUP_ID,
    `🚫 O horário de *${opt}* atingiu o limite de ${CAPACITY} participantes e foi fechado.`
  );
  console.log("🔒 Fechado:", opt);
}

async function notifyGroupSlotOpened(client, opt) {
  await client.sendText(
    GROUP_ID,
    `🔓 O horário de *${opt}* agora tem vaga novamente!`
  );
  console.log("🔓 Reaberto:", opt);
}

async function notifyUserSlotClosed(client, opt, userId) {
  const c = await client.getContact(userId);
  const name = c.pushname || c.formattedName || "Participante";
  await client.sendText(
    GROUP_ID,
    `${name}, o horário de *${opt}* está fechado. Por favor, escolha outro.`,
    null,
    { mentions: [userId] }
  );
  console.log(`✉️ Aviso a ${name}: ${opt} fechado`);
}

async function checkVotes(client, pollId, state) {
  try {
    console.log("▶️ checkVotes (pollId =", pollId, ")");
    console.log("   fullNotified =", [...state.fullNotified]);

    const { votes } = await client.getVotes(pollId);
    const counts = countVotesByName(votes);

    // 1) reabertura
    for (const opt of state.fullNotified) {
      if ((counts[opt] || 0) < CAPACITY) {
        await notifyGroupSlotOpened(client, opt);
        state.fullNotified.delete(opt);
        for (const key of state.userNotified) {
          if (key.startsWith(opt + ":")) state.userNotified.delete(key);
        }
      }
    }

    // 2) fechamento & 3) votos extras
    for (const [opt, cnt] of Object.entries(counts)) {
      if (cnt === CAPACITY && !state.fullNotified.has(opt)) {
        await notifyGroupCapacityReached(client, opt);
        state.fullNotified.add(opt);
      }
      if (cnt > CAPACITY) {
        const extra = getLastVoterForOption(votes, opt);
        const key = `${opt}:${extra}`;
        if (
          extra &&
          state.fullNotified.has(opt) &&
          !state.userNotified.has(key)
        ) {
          await notifyUserSlotClosed(client, opt, extra);
          state.userNotified.add(key);
        }
      }
    }
  } catch (err) {
    console.error("❌ Erro em checkVotes:", err);
  }
}

//
// ── MAIN ────────────────────────────────────────────────────────────────────────
(async () => {
  const client = await initClient();

  // estado de notificações
  const state = {
    fullNotified: new Set(),
    userNotified: new Set(),
  };

  // variável mutável de pollId
  let pollId = await sendPoll(client);

  // cron contínuo de verificação de votos
  cron.schedule(POLL_CRON, () => checkVotes(client, pollId, state), { tz: TZ });

  // cron diário de reset: limpa estado e envia enquete nova
  cron.schedule(
    DAILY_CRON,
    async () => {
      console.log("🔄 reset diário: limpando estado e enviando enquete nova");
      state.fullNotified.clear();
      state.userNotified.clear();
      pollId = await sendPoll(client);
    },
    { tz: TZ }
  );
})();
