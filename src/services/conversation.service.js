'use strict';

/**
 * Orquestra o atendimento pelo WhatsApp:
 *   webhook -> job inbound -> registra mensagem (idempotente) -> job reply com debounce -> IA -> classificação -> resposta
 *
 * O debounce e a serialização por lead ficam na fila do banco (aim_job, ver job.service.js),
 * então funcionam com várias instâncias e sobrevivem a reinício.
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
const jobs = require('./job.service');
const usage = require('./usage.service');
const billing = require('./billing.service');
const visits = require('./visit.service');
const { slotLabel } = require('./time');

const OPT_OUT_RE = /^\s*(sair|parar|pare|stop|cancelar|descadastrar)\s*[.!]*\s*$/i;
const WINDOW_MS = 24 * 60 * 60 * 1000;

const OPT_OUT_REPLY = 'Tudo certo, não vou mais te enviar mensagens. Se mudar de ideia, é só mandar um oi.';
const UNSUPPORTED_REPLY = 'Por enquanto consigo ler só mensagens de texto. Pode me escrever sua dúvida?';
// Conta sem direito a conversa nova: resposta fixa, sem IA, e o lead vai para o corretor.
const BLOCKED_REPLY = 'Olá! Recebemos sua mensagem. Um corretor vai continuar o seu atendimento por aqui em breve.';

function privacyNotice() {
  return `\n\nSeus dados são usados só para este atendimento (${env.PRIVACY_URL}). Para não receber mais mensagens, responda SAIR.`;
}

/**
 * Registra uma mensagem recebida. Idempotente por wa_message_id (a Meta reenvia webhooks).
 * A conta vem do job (resolvida ao enfileirar). Sem ela, resolve pelo phone_number_id.
 * @returns {{ tenant, leadId, action: 'reply'|'opt_out'|'unsupported'|'ignore' } | null}
 */
async function registerInbound(msg, tenantId) {
  const tenant = tenantId
    ? await Tenant.findOne({ where: { id: tenantId, isActive: true } })
    : await Tenant.findOne({ where: { waPhoneNumberId: msg.phoneNumberId, isActive: true } });
  if (!tenant) {
    logger.warn({ phoneNumberId: msg.phoneNumberId }, 'Mensagem de conta inexistente ou desativada');
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
  const waMessageId = await wa.sendText(tenant, waId, body);
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

/**
 * Entrada do webhook: resolve a conta de cada mensagem pelo phone_number_id e grava um job inbound.
 * Número não cadastrado é ignorado com aviso. Erro de banco sobe para o controller responder 500.
 * @returns {Promise<number>} quantas mensagens foram enfileiradas
 */
async function acceptInbound(messages) {
  const tenants = new Map();
  let queued = 0;
  for (const msg of messages) {
    if (!tenants.has(msg.phoneNumberId)) {
      tenants.set(msg.phoneNumberId, await Tenant.findOne({ where: { waPhoneNumberId: msg.phoneNumberId, isActive: true } }));
    }
    const tenant = tenants.get(msg.phoneNumberId);
    if (!tenant) {
      logger.warn({ phoneNumberId: msg.phoneNumberId }, 'Webhook de número não cadastrado');
      continue;
    }
    await jobs.enqueueInbound(tenant.id, msg);
    queued += 1;
  }
  return queued;
}

/** Simulador do painel (fora de produção): enfileira direto na conta logada, com ou sem número. */
async function acceptSimulated(tenantId, msg) {
  await jobs.enqueueInbound(tenantId, msg);
}

/** Processa uma mensagem normalizada do webhook (roda no worker, a partir do job inbound). */
async function handleInbound(msg, tenantId) {
  const res = await registerInbound(msg, tenantId);
  if (!res) return;
  const { tenant, leadId, action } = res;

  if (action === 'opt_out') {
    await sendAndRecord(tenant, leadId, msg.waId, OPT_OUT_REPLY, 'system');
  } else if (action === 'unsupported') {
    await sendAndRecord(tenant, leadId, msg.waId, UNSUPPORTED_REPLY, 'system');
    await markInboundAnswered(tenant.id, leadId);
  } else if (action === 'reply') {
    // Debounce: o lead costuma mandar 2-3 mensagens seguidas. Cada uma empurra o horário da
    // resposta pendente, e a IA responde tudo de uma vez após REPLY_DEBOUNCE_MS sem mensagem nova.
    await jobs.enqueueReply(tenant.id, leadId);
  }
}

/**
 * Uma rodada de resposta da IA. Roda no worker (job reply), nunca duas ao mesmo tempo para o
 * mesmo lead. Lança erro em falha da IA ou do envio: o worker agenda nova tentativa.
 */
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

    // Plano: conversa nova sem assinatura ativa ou acima do limite do mês vai direto para humano.
    const gate = await billing.conversationGate(leadId, t);
    if (!gate.ok) {
      const property = lead.propertyId ? await Property.findByPk(lead.propertyId, { transaction: t }) : null;
      return { blocked: gate.reason, cutoff: lastInbound.createdAt, property };
    }

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
    // Horários livres de visita: só com imóvel definido e lead que ainda pode visitar.
    const visitSlots =
      property && plainLead.classification !== 'frio'
        ? (await visits.offerForLead(tenant, t)).map((s) => ({ id: s.toISOString(), label: slotLabel(s, tenant.timezone || 'America/Sao_Paulo') }))
        : [];

    return {
      lead: plainLead,
      history,
      property,
      activeProperties: property ? [] : activeProperties,
      alternatives,
      visitSlots,
      cutoff: lastInbound.createdAt,
    };
  });
  if (!ctx) return;
  if (ctx.blocked) {
    await deliver(tenant, leadId, await handoffWithoutAi(tenant, leadId, ctx));
    return;
  }

  // ---- B) IA (fora de transação) ----
  const system = buildSystemPrompt({
    tenant,
    property: ctx.property,
    activeProperties: ctx.activeProperties,
    alternatives: ctx.alternatives,
    lead: ctx.lead,
    today: new Date().toLocaleDateString('pt-BR', { timeZone: tenant.timezone || 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }),
    visitSlots: ctx.visitSlots,
  });
  const turn = await ai.runTurn({ system, history: ctx.history.map((m) => m.get({ plain: true })) });

  // ---- C) Aplica resultado (transação) ----
  const outcome = await inTx(tenant.id, async (t) => {
    const lead = await Lead.findByPk(leadId, { transaction: t, lock: t.LOCK.UPDATE });
    // A chamada à IA já aconteceu: conta no uso mesmo se a resposta for descartada abaixo.
    await usage.countAiTurn(tenant.id, leadId, t);
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
    // Dúvida nova (não só repetida): marca a data, usada pelo aviso de cadastro incompleto.
    if (openQuestions.length > (lead.openQuestions || []).length) patch.openQuestionsAt = new Date();

    // Visita: a IA só pode marcar um dos horários oferecidos nesta rodada.
    let booking = null;
    if (turn.visitSlot && property && ctx.visitSlots.some((s) => s.id === turn.visitSlot)) {
      booking = await visits.bookInTx(t, { tenant, leadId, propertyId: property.id, startsAt: turn.visitSlot, createdBy: 'assistente' });
    }

    let handoff = false;
    let extraReply = '';
    if (booking && booking.ok) {
      // Visita marcada: o dono é avisado, e a assistente segue respondendo dúvidas até a visita.
      handoff = true;
      Object.assign(patch, {
        status: 'visita_agendada',
        visitPreference: booking.visit.label,
        handoffAt: lead.handoffAt || new Date(),
        handoffReason: 'visita_agendada',
        handoffSummary: (
          turn.handoffSummary ||
          describeQualification({
            name: lead.displayName,
            property: property.get({ plain: true }),
            qualification,
            visitPreference: booking.visit.label,
            classification,
          })
        ).slice(0, 1000),
      });
    } else if (
      (booking && !booking.ok) ||
      turn.nextAction === 'transferir_humano' ||
      // Sem horários para oferecer, lead quente com preferência de visita vai para o corretor combinar.
      (!ctx.visitSlots.length && lead.status !== 'visita_agendada' && classification === 'quente' && visitPreference)
    ) {
      handoff = true;
      if (booking && !booking.ok) extraReply = '\n\nEsse horário acabou de ser reservado por outra pessoa. Um corretor vai falar com você para combinar outro.';
      Object.assign(patch, {
        status: 'transferido',
        botActive: false,
        handoffAt: new Date(),
        handoffReason: (booking ? 'horario_ocupado' : turn.handoffReason || (visitPreference ? 'visita_solicitada' : 'solicitado_pela_ia')).slice(0, 300),
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

    let reply = turn.reply + extraReply;
    if (!lead.privacyNoticeSentAt) {
      reply += privacyNotice();
      patch.privacyNoticeSentAt = new Date();
    }

    const previous = { lastRepliedInboundAt: lead.lastRepliedInboundAt, privacyNoticeSentAt: lead.privacyNoticeSentAt };
    await lead.update(patch, { transaction: t });
    return { reply, handoff, previous, waId: lead.waId, lead: lead.get({ plain: true }), property };
  });
  await deliver(tenant, leadId, outcome);
}

/** Envia a resposta decidida e avisa o dono na transferência. */
async function deliver(tenant, leadId, outcome) {
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
 * Conta sem direito a conversa nova (teste acabou, pagamento atrasado, limite do mês): não chama a IA.
 * O lead recebe uma mensagem fixa e vai para o corretor, com o motivo registrado.
 */
async function handoffWithoutAi(tenant, leadId, ctx) {
  return inTx(tenant.id, async (t) => {
    const lead = await Lead.findByPk(leadId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!lead.botActive) return null;
    const property = ctx.property ? ctx.property.get({ plain: true }) : null;
    const patch = {
      status: 'transferido',
      botActive: false,
      handoffAt: new Date(),
      handoffReason: `plano:${ctx.blocked}`.slice(0, 300),
      handoffSummary: describeQualification({
        name: lead.displayName,
        property,
        qualification: lead.qualification,
        visitPreference: lead.visitPreference,
        classification: lead.classification,
      }).slice(0, 1000),
      lastRepliedInboundAt: ctx.cutoff,
    };
    let reply = BLOCKED_REPLY;
    if (!lead.privacyNoticeSentAt) {
      reply += privacyNotice();
      patch.privacyNoticeSentAt = new Date();
    }
    const previous = { lastRepliedInboundAt: lead.lastRepliedInboundAt, privacyNoticeSentAt: lead.privacyNoticeSentAt };
    await lead.update(patch, { transaction: t });
    logger.info({ leadId, reason: ctx.blocked }, 'Lead transferido sem IA (plano)');
    return { reply, handoff: true, previous, waId: lead.waId, lead: lead.get({ plain: true }), property: ctx.property };
  });
}

/**
 * Recuperação: leads com mensagem recebida e ainda sem resposta cujo job se perdeu ou esgotou
 * as tentativas. Considera só mensagens das últimas 2h e mais antigas que 1 min. Não mexe em
 * resposta já pendente; se houver uma executando, a nova roda depois e vê que já foi respondido.
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
    await jobs.enqueueReply(tenant.id, id, { delayMs: 0, mode: 'recover' });
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
    if (l.anonymizedAt) return { error: 'ANONYMIZED' };
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
  acceptInbound,
  acceptSimulated,
  handleInbound,
  registerInbound,
  processReply,
  recoverUnanswered,
  sendHumanMessage,
  sendAndRecord,
  OPT_OUT_RE,
  WINDOW_MS,
};
