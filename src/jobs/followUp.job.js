'use strict';

/**
 * Job periódico (a cada FOLLOWUP_JOB_INTERVAL_MS):
 *  1) recupera mensagens sem resposta (reinício, falha da IA/envio);
 *  2) follow-up automático: se o lead parou de responder, manda UMA mensagem de retomada,
 * ainda dentro da janela de 24h (texto livre permitido). Fora da janela, só com template — não fazemos no MVP.
 *
 * O UPDATE ... RETURNING "reivindica" o lead (followup_count 0 -> 1) de forma atômica,
 * então duas instâncias do job nunca mandam o mesmo follow-up.
 */

const { QueryTypes } = require('sequelize');
const env = require('../config/env');
const logger = require('../config/logger');
const inTx = require('../db/inTx');
const { sequelize, Tenant } = require('../models');
const { sendAndRecord, recoverUnanswered } = require('../services/conversation.service');

function followUpText(name) {
  const first = name ? `, ${String(name).split(' ')[0]}` : '';
  return `Oi${first}! Passando para saber se ficou alguma dúvida sobre o imóvel. Se quiser, já te ajudo a agendar uma visita.`;
}

async function claimCandidates(tenantId) {
  return inTx(tenantId, (t) =>
    sequelize.query(
      `UPDATE aim_lead
          SET followup_count = followup_count + 1, updated_at = now()
        WHERE status = 'em_atendimento'
          AND bot_active = true
          AND followup_count = 0
          AND last_outbound_at IS NOT NULL
          AND last_inbound_at IS NOT NULL
          AND last_outbound_at > last_inbound_at
          AND last_outbound_at < now() - make_interval(mins => :afterMin)
          AND last_inbound_at  > now() - interval '23 hours'
        RETURNING id, wa_id AS "waId", display_name AS "displayName"`,
      { replacements: { afterMin: env.FOLLOWUP_AFTER_MINUTES }, type: QueryTypes.SELECT, transaction: t }
    )
  );
}

async function runOnce() {
  const tenants = await Tenant.findAll({ where: { isActive: true } });
  for (const tenant of tenants) {
    if (!tenant.waPhoneNumberId) continue;
    await recoverUnanswered(tenant);
    const leads = await claimCandidates(tenant.id);
    for (const lead of leads) {
      try {
        await sendAndRecord(tenant, lead.id, lead.waId, followUpText(lead.displayName), 'bot');
      } catch (err) {
        logger.error({ leadId: lead.id, code: err.code }, 'Falha no follow-up');
      }
    }
  }
}

function start() {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await runOnce();
    } catch (err) {
      logger.error({ message: err.message }, 'Job de follow-up falhou');
    } finally {
      busy = false;
    }
  }, env.FOLLOWUP_JOB_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { start, runOnce, followUpText };
