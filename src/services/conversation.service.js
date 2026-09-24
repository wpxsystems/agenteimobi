'use strict';

/**
 * Orquestra o atendimento pelo WhatsApp:
 *   webhook -> registra mensagem (idempotente) -> debounce por lead -> IA -> classificação -> resposta
 *
 * Nenhuma chamada de rede (Meta/Anthropic) acontece dentro de transação de banco.
 */

const { QueryTypes } = require('sequelize');
const env = require('../config/env');
const logger = require('../config/logger');
const inTx = require('../db/inTx');
const { sequelize, Tenant, Lead, Message, Property } = require('../models');
const { extractPropertyCode } = require('./whatsapp/webhookParser');
const wa = require('./whatsapp/client');
const ai = require('./ai/claude.client');
const { buildSystemPrompt } = require('./ai/prompt');
const { scoreLead, mergeQualification, findAlternatives, mergeOpenQuestions, describeQualification } = require('./scoring');
const notification = require('./notification.service');

const OPT_OUT_RE = /^\s*(sair|parar|pare|stop|cancelar|descadastrar)\s*[.!]*\s*$/i;
const WINDOW_MS = 24 * 60 * 60 * 1000;

const OPT_OUT_REPLY = 'Tudo certo, não vou mais te enviar mensagens. Se mudar de ideia, é só mandar um oi.';
const UNSUPPORTED_REPLY = 'Por enquanto consigo ler só mensagens de texto. Pode me escrever sua dúvida?';

// ---------------------------------------------------------------------------
// Estado em memória do debounce (MVP: uma instância). Ver docs/logica para escalar.
// ---------------------------------------------------------------------------
const timers = new Map(); // leadId -> Timeout
const running = new Map(); // leadId -> { pending: boolean }

function privacyNotice() {
  return `\n\nSeus dados são usados só para este atendimento (${env.PRIVACY_URL}). Para não receber mais mensagens, responda SAIR.`;
}

/**
 * Registra uma mensagem recebida. Idempotente por wa_message_id (a Meta reenvia webhooks).
 * @returns {{ tenant, leadId, action: 'reply'|'opt_out'|'unsupported'|'ignore' } | null}
 */
async function registerInbound(msg) {
  const tenant = await Tenant.findOne({ where: { waPhoneNumberId: msg.phoneNumberId, isActive: true } });
  if (!tenant) {
    logger.warn({ phoneNumberId: msg.phoneNumberId }, 'Webhook de número não cadastrado');
    return null;
  }

  return inTx(tenant.id, async (t) => {
    // Upsert do lead sem corrida (dois webhooks simultâneos do mesmo número novo).
    const [{ id: leadId }] = await sequelize.query(
      `INSERT INTO aim_lead (tenant_id, wa_id, display_name, source)
       VALUES (:tenantId, :waId, :name, :source)
       ON CONFLICT (tenant_id, wa_id) DO UPDATE SET updated_at = now()
       RETURNING id`,
      {
        replacements: {
          tenantId: tenant.id,
          waId: msg.waId,
          name: msg.name ? msg.name.slice(0, 120) : null,
          source: msg.referralSource ? 'ctwa' : 'link',
        },
        type: QueryTypes.SELECT,
        transaction: t,
      }
    );

    const inserted = await sequelize.query(
      `INSERT INTO aim_message (tenant_id, lead_id, direction, author, wa_message_id, msg_type, body, created_at, updated_at)
       VALUES (:tenantId, :leadId, 'in', 'lead', :waMessageId, :type, :body, now(), now())
       ON CONFLICT (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
       RETURNING id`,
      {
        replacements: { tenantId: tenant.id, leadId, waMessageId: msg.waMessageId, type: msg.type, body: msg.text },
        type: QueryTypes.SELECT,
        transaction: t,
      }
    );
    if (inserted.length === 0) return { tenant, leadId, action: 'ignore' }; // duplicado

    const lead = await Lead.findByPk(leadId, { transaction: t, lock: t.LOCK.UPDATE });
    const patch = { lastInboundAt: new Date(), followupCount: 0 };
    if (!lead.displayName && msg.name) patch.displayName = msg.name.slice(0, 120);
    if (lead.status === 'novo') patch.status = 'em_atendimento';

    // Link do WhatsApp traz "#CODIGO" na mensagem pré-preenchida -> vincula o imóvel.
    const code = extractPropertyCode(msg.text);
    if (code && !lead.propertyId) {
      const property = await Property.findOne({ where: { code, isActive: true }, transaction: t });
      if (property) patch.propertyId = property.id;
    }

    let action = 'reply';
    if (lead.status === 'opt_out' || lead.status === 'descartado') {
      action = 'ignore';
    } else if (OPT_OUT_RE.test(msg.text)) {
      Object.assign(patch, { status: 'opt_out', optOutAt: new Date(), botActive: false });
      action = 'opt_out';
    } else if (!lead.botActive) {
      action = 'ignore'; // humano assumiu a conversa
    } else if (!msg.text.trim()) {
      action = 'unsupported';
    }

    await lead.update(patch, { transaction: t });
    return { tenant, leadId, action };
  });
}

/** Envia texto e registra a mensagem de saída. */
async function sendAndRecord(tenant, leadId, waId, body, author) {
  const waMessageId = await wa.sendText(tenant.waPhoneNumberId, waId, body);
  await inTx(tenant.id, async (t) => {
    await Message.create(
      { tenantId: tenant.id, leadId, direction: 'out', author, waMessageId, msgType: 'text', body },
      { transaction: t }
    );
    await Lead.update({ lastOutboundAt: new Date() }, { where: { id: leadId }, transaction: t });
  });
  return waMessageId;
}

/** Marca como respondidas todas as mensagens recebidas até agora (usa o relógio do banco, igual ao created_at). */
function markInboundAnswered(tenantId, leadId) {
  return inTx(tenantId, (t) =>
    sequelize.query(
      `UPDATE aim_lead SET last_replied_inbound_at =
         (SELECT max(created_at) FROM aim_message WHERE lead_id = :leadId AND direction = 'in')
       WHERE id = :leadId`,
      { replacements: { leadId }, transaction: t }
    )
  );
}

/** Ponto de entrada do webhook para cada mensagem normalizada. */
async function handleInbound(msg) {
  const res = await registerInbound(msg);
  if (!res) return;
  const { tenant, leadId, action } = res;

  if (action === 'opt_out') {
    await sendAndRecord(tenant, leadId, msg.waId, OPT_OUT_REPLY, 'system');
  } else if (action === 'unsupported') {
    await sendAndRecord(tenant, leadId, msg.waId, UNSUPPORTED_REPLY, 'system');
    await markInboundAnswered(tenant.id, leadId);
  } else if (action === 'reply') {
    scheduleReply(tenant, leadId);
  }
}

/**
 * Debounce: o lead costuma mandar 2-3 mensagens seguidas. Espera REPLY_DEBOUNCE_MS
 * sem mensagem nova e responde tudo de uma vez. Se já houver resposta em andamento,
 * marca pendente e roda de novo ao terminar.
 */
function scheduleReply(tenant, leadId) {
  clearTimeout(timers.get(leadId));
  timers.set(
    leadId,
    setTimeout(() => {
      timers.delete(leadId);
      runReply(tenant, leadId);
    }, env.REPLY_DEBOUNCE_MS)
  );
}

async function runReply(tenant, leadId) {
  const state = running.get(leadId);
  if (state) {
    state.pending = true;
    return;
  }
  running.set(leadId, { pending: false });
  try {
    await processReply(tenant, leadId);
  } catch (err) {
    logger.error({ err: { code: err.code, message: err.message }, leadId }, 'Falha ao responder lead');
  } finally {
    const { pending } = running.get(leadId);
    running.delete(leadId);
    if (pending) runReply(tenant, leadId);
  }
}

async function processReply(tenant, leadId) {
  // ---- A) Carrega contexto (transação curta) ----
  const ctx = await inTx(tenant.id, async (t) => {
    const lead = await Lead.findByPk(leadId, { transaction: t });
    if (!lead || !lead.botActive || ['opt_out', 'descartado', 'transferido'].includes(lead.status)) return null;

    const lastInbound = await Message.findOne({
      where: { leadId, direction: 'in' },
      order: [['createdAt', 'DESC']],
      transaction: t,
    });
    if (!lastInbound) return null;
    if (lead.lastRepliedInboundAt && lastInbound.createdAt <= lead.lastRepliedInboundAt) return null; // já respondido
    if (Date.now() - new Date(lastInbound.createdAt).getTime() > WINDOW_MS) return null; // fora da janela

    const history = (
      await Message.findAll({
        where: { leadId },
        order: [['createdAt', 'DESC']],
        limit: env.HISTORY_MAX_MESSAGES,
        transaction: t,
      })
    ).reverse();

    const property = lead.propertyId ? await Property.findByPk(lead.propertyId, { transaction: t }) : null;
    // Sempre carrega os ativos: sem imóvel, a IA pergunta qual; com imóvel, viram alternativas compatíveis.
    const activeProperties = await Property.findAll({ where: { isActive: true }, order: [['createdAt', 'DESC']], limit: 20, transaction: t });
    const plainLead = lead.get({ plain: true });
    const alternatives = property
      ? findAlternatives(plainLead.qualification, activeProperties.map((p) => p.get({ plain: true })), property.id)
      : [];

    return {
      lead: plainLead,
      history,
      property,
      activeProperties: property ? [] : activeProperties,
      alternatives,
      cutoff: lastInbound.createdAt,
    };
  });
  if (!ctx) return;

  // ---- B) IA (fora de transação) ----
  const system = buildSystemPrompt({
    tenant,
    property: ctx.property,
    activeProperties: ctx.activeProperties,
    alternatives: ctx.alternatives,
    lead: ctx.lead,
    today: new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
  });
  const turn = await ai.runTurn({ system, history: ctx.history.map((m) => m.get({ plain: true })) });

  // ---- C) Aplica resultado (transação) ----
  const outcome = await inTx(tenant.id, async (t) => {
    const lead = await Lead.findByPk(leadId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!lead.botActive) return null; // humano assumiu enquanto a IA pensava

    let property = ctx.property;
    let propertyId = lead.propertyId;
    // Vincula o imóvel indicado pela IA, ou troca quando o lead passou a querer outro (alternativa oferecida).
    if (turn.propertyCode && turn.propertyCode !== (property ? property.code : null)) {
      const found = await Property.findOne({ where: { code: turn.propertyCode, isActive: true }, transaction: t });
      if (found) {
        property = found;
        propertyId = found.id;
      }
    }

    const qualification = mergeQualification(lead.qualification, turn.facts);
    const { score, classification, disqualifyReasons } = scoreLead(qualification, property && property.get({ plain: true }));
    const visitPreference = turn.visitPreference || lead.visitPreference;
    const openQuestions = mergeOpenQuestions(lead.openQuestions, turn.openQuestions);

    const patch = {
      propertyId,
      qualification,
      score,
      classification,
      disqualifyReasons,
      visitPreference,
      openQuestions,
      lastRepliedInboundAt: ctx.cutoff,
    };

    let handoff = false;
    if (turn.nextAction === 'transferir_humano' || (classification === 'quente' && visitPreference)) {
      handoff = true;
      Object.assign(patch, {
        status: 'transferido',
        botActive: false,
        handoffAt: new Date(),
        handoffReason: (turn.handoffReason || (visitPreference ? 'visita_solicitada' : 'solicitado_pela_ia')).slice(0, 300),
        // Resumo da IA quando ela transferiu; senão um resumo determinístico dos fatos.
        handoffSummary: (
          turn.handoffSummary ||
          describeQualification({
            name: lead.displayName,
            property: property && property.get({ plain: true }),
            qualification,
            visitPreference,
            classification,
          })
        ).slice(0, 1000),
      });
    } else if (turn.nextAction === 'encerrar') {
      Object.assign(patch, { status: 'descartado', botActive: false });
    }

    let reply = turn.reply;
    if (!lead.privacyNoticeSentAt) {
      reply += privacyNotice();
      patch.privacyNoticeSentAt = new Date();
    }

    const previous = { lastRepliedInboundAt: lead.lastRepliedInboundAt, privacyNoticeSentAt: lead.privacyNoticeSentAt };
    await lead.update(patch, { transaction: t });
    return { reply, handoff, previous, waId: lead.waId, lead: lead.get({ plain: true }), property };
  });
  if (!outcome) return;

  try {
    await sendAndRecord(tenant, leadId, outcome.waId, outcome.reply, 'bot');
  } catch (err) {
    // Envio falhou: desfaz a marcação de "respondido" para o job de recuperação tentar de novo.
    // A classificação calculada é mantida (continua válida).
    await inTx(tenant.id, (t) => Lead.update(outcome.previous, { where: { id: leadId }, transaction: t }));
    if (outcome.handoff) await notification.notifyHandoff(tenant, outcome.lead, outcome.property);
    throw err;
  }
  if (outcome.handoff) await notification.notifyHandoff(tenant, outcome.lead, outcome.property);
}

/**
 * Recuperação: leads com mensagem recebida e ainda sem resposta (reinício do processo,
 * falha da IA ou do envio). Considera só mensagens das últimas 2h e mais antigas que 1 min
 * (para não competir com o debounce normal).
 */
async function recoverUnanswered(tenant) {
  const rows = await inTx(tenant.id, (t) =>
    sequelize.query(
      `SELECT l.id FROM aim_lead l
        WHERE l.bot_active = true
          AND l.status IN ('novo', 'em_atendimento')
          AND EXISTS (
            SELECT 1 FROM aim_message m
             WHERE m.lead_id = l.id AND m.direction = 'in'
               AND m.created_at > COALESCE(l.last_replied_inbound_at, '-infinity'::timestamptz)
               AND m.created_at < now() - interval '1 minute'
               AND m.created_at > now() - interval '2 hours')
        LIMIT 50`,
      { type: QueryTypes.SELECT, transaction: t }
    )
  );
  for (const { id } of rows) {
    if (!timers.has(id) && !running.has(id)) scheduleReply(tenant, id);
  }
  return rows.length;
}

/**
 * Resposta manual do corretor pela API. Assume a conversa (desliga o bot).
 */
async function sendHumanMessage(tenantId, leadId, text) {
  const tenant = await Tenant.findByPk(tenantId);
  const lead = await inTx(tenantId, async (t) => {
    const l = await Lead.findByPk(leadId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!l) return null;
    if (l.status === 'opt_out') return { error: 'OPT_OUT' };
    if (!l.lastInboundAt || Date.now() - new Date(l.lastInboundAt).getTime() > WINDOW_MS) {
      return { error: 'WINDOW_CLOSED' };
    }
    await l.update({ botActive: false }, { transaction: t });
    return l.get({ plain: true });
  });
  if (!lead) return null;
  if (lead.error) return lead;
  await sendAndRecord(tenant, leadId, lead.waId, text, 'human');
  return { ok: true };
}

module.exports = {
  handleInbound,
  registerInbound,
  processReply,
  recoverUnanswered,
  sendHumanMessage,
  sendAndRecord,
  OPT_OUT_RE,
  WINDOW_MS,
  _internals: { timers, running },
};
