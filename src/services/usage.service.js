'use strict';

/**
 * Registro de uso por conta e por mês (aim_usage_month). Nesta fase só mede;
 * os limites por plano usam estes contadores depois.
 * O mês é o do fuso de São Paulo, calculado pelo banco.
 */

const { QueryTypes } = require('sequelize');
const inTx = require('../db/inTx');
const { sequelize } = require('../models');

const MONTH_SQL = "date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date";
const FIELDS = { conversations: 'conversations', aiCalls: 'ai_calls', templatesSent: 'templates_sent', adCopies: 'ad_copies' };

function normalizeDelta(delta = {}) {
  const out = {};
  for (const key of Object.keys(FIELDS)) {
    const v = delta[key] === undefined ? 0 : delta[key];
    if (!Number.isInteger(v) || v < 0) throw new TypeError(`Incremento de uso inválido: ${key}`);
    out[key] = v;
  }
  for (const key of Object.keys(delta)) {
    if (!(key in FIELDS)) throw new TypeError(`Contador de uso desconhecido: ${key}`);
  }
  return out;
}

/** Soma os incrementos no mês corrente. Deve rodar dentro de inTx da mesma conta. */
async function add(tenantId, delta, t) {
  const d = normalizeDelta(delta);
  if (Object.values(d).every((v) => v === 0)) return;
  await sequelize.query(
    `INSERT INTO aim_usage_month (tenant_id, month, conversations, ai_calls, templates_sent, ad_copies)
     VALUES (:tenantId, ${MONTH_SQL}, :conversations, :aiCalls, :templatesSent, :adCopies)
     ON CONFLICT (tenant_id, month) DO UPDATE SET
       conversations  = aim_usage_month.conversations  + EXCLUDED.conversations,
       ai_calls       = aim_usage_month.ai_calls       + EXCLUDED.ai_calls,
       templates_sent = aim_usage_month.templates_sent + EXCLUDED.templates_sent,
       ad_copies      = aim_usage_month.ad_copies      + EXCLUDED.ad_copies,
       updated_at     = now()`,
    { replacements: { tenantId, ...d }, transaction: t }
  );
}

/**
 * Uma rodada da IA para um lead: +1 chamada, e +1 conversa se o lead ainda não foi contado neste mês.
 * Deve rodar dentro de inTx da mesma conta.
 * @returns {Promise<boolean>} true se contou uma conversa nova
 */
async function countAiTurn(tenantId, leadId, t) {
  const rows = await sequelize.query(
    `UPDATE aim_lead SET usage_month = ${MONTH_SQL}
      WHERE id = :leadId AND usage_month IS DISTINCT FROM ${MONTH_SQL}
      RETURNING id`,
    { replacements: { leadId }, type: QueryTypes.SELECT, transaction: t }
  );
  const isNew = rows.length > 0;
  await add(tenantId, { conversations: isNew ? 1 : 0, aiCalls: 1 }, t);
  return isNew;
}

/** Contadores do mês corrente (zerados se ainda não houve uso). Com `tx`, roda dentro dela. */
async function current(tenantId, tx) {
  const run = (t) =>
    sequelize.query(
      `SELECT to_char(${MONTH_SQL}, 'YYYY-MM') AS month,
              COALESCE(u.conversations, 0)  AS conversations,
              COALESCE(u.ai_calls, 0)       AS "aiCalls",
              COALESCE(u.templates_sent, 0) AS "templatesSent",
              COALESCE(u.ad_copies, 0)      AS "adCopies"
         FROM (SELECT 1) one
         LEFT JOIN aim_usage_month u ON u.tenant_id = :tenantId AND u.month = ${MONTH_SQL}`,
      { replacements: { tenantId }, type: QueryTypes.SELECT, transaction: t }
    );
  const [row] = tx ? await run(tx) : await inTx(tenantId, run);
  return row;
}

module.exports = { add, countAiTurn, current, normalizeDelta, MONTH_SQL };
