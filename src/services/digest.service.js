'use strict';

/**
 * Resumo do dia (item 2.1 do plano). Ver docs/logica/rotina-do-dono.md.
 *
 *   today(tenantId) : números do dia, calculados na hora (tela "Hoje" do painel)
 *   runDue(tenant)  : depois das 8h locais, uma vez por dia, manda o resumo no WhatsApp do dono.
 *                     A linha em aim_digest é gravada ANTES do envio (reivindica o dia): duas instâncias
 *                     nunca mandam o mesmo resumo. Dia sem nada relevante não gera envio.
 */

const { QueryTypes } = require('sequelize');
const env = require('../config/env');
const logger = require('../config/logger');
const inTx = require('../db/inTx');
const { sequelize, Tenant } = require('../models');
const { localDate, localParts } = require('./time');
const wa = require('./whatsapp/client');
const usage = require('./usage.service');

const SEND_FROM_HOUR = 8;

/** Números do dia na hora local da conta. Dentro de inTx da conta. */
async function countsInTx(t, tz) {
  const [row] = await sequelize.query(
    `WITH limites AS (
       SELECT date_trunc('day', now() AT TIME ZONE :tz) AT TIME ZONE :tz AS hoje,
              (date_trunc('day', now() AT TIME ZONE :tz) - interval '1 day') AT TIME ZONE :tz AS ontem,
              (date_trunc('day', now() AT TIME ZONE :tz) + interval '1 day') AT TIME ZONE :tz AS amanha
     ), aguardando AS (
       SELECT l.classification, l.handoff_at
         FROM aim_lead l
        WHERE l.status = 'transferido' AND l.anonymized_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM aim_message m WHERE m.lead_id = l.id AND m.author = 'human'
                           AND m.created_at >= COALESCE(l.handoff_at, l.updated_at))
     )
     SELECT
       (SELECT count(*) FROM aguardando WHERE classification = 'quente')::int AS "quentesAguardando",
       (SELECT count(*) FROM aguardando)::int AS "aguardando",
       (SELECT floor(extract(epoch FROM now() - min(handoff_at)) / 60) FROM aguardando)::int AS "esperaMaisLongaMin",
       (SELECT count(*) FROM aim_lead l, limites WHERE l.created_at >= limites.ontem AND l.created_at < limites.hoje)::int AS "novosOntem",
       (SELECT count(*) FROM aim_lead l, limites WHERE l.created_at >= limites.ontem AND l.created_at < limites.hoje AND l.classification = 'quente')::int AS "quentesOntem",
       (SELECT count(*) FROM aim_visit v, limites WHERE v.status = 'agendada' AND v.starts_at >= limites.hoje AND v.starts_at < limites.amanha)::int AS "visitasHoje",
       (SELECT count(*) FROM aim_alert WHERE resolved_at IS NULL)::int AS "avisos"`,
    { replacements: { tz }, type: QueryTypes.SELECT, transaction: t }
  );
  return row;
}

const isRelevant = (c) => c.aguardando + c.novosOntem + c.visitasHoje + c.avisos > 0;

async function today(tenantId) {
  return inTx(tenantId, async (t) => {
    const tenant = await Tenant.findByPk(tenantId, { transaction: t });
    return { ...(await countsInTx(t, tenant.timezone)), day: localDate(new Date(), tenant.timezone) };
  });
}

/**
 * Resumo diário no WhatsApp do dono, se já passou das 8h locais e ainda não saiu hoje.
 * @returns {Promise<'nao_e_hora'|'ja_enviado'|'desligado'|'whatsapp'|'so_painel'|'nada_relevante'|'falhou'>}
 */
async function runDue(tenant, now = new Date()) {
  if (!tenant.digestEnabled) return 'desligado';
  if (localParts(now, tenant.timezone).h < SEND_FROM_HOUR) return 'nao_e_hora';
  const day = localDate(now, tenant.timezone);

  // Reivindica o dia antes de enviar.
  const claimed = await inTx(tenant.id, async (t) => {
    const rows = await sequelize.query(
      `INSERT INTO aim_digest (tenant_id, day, delivery) VALUES (:tenantId, :day, 'nada_relevante')
       ON CONFLICT (tenant_id, day) DO NOTHING RETURNING id`,
      { replacements: { tenantId: tenant.id, day }, type: QueryTypes.SELECT, transaction: t }
    );
    if (!rows.length) return null;
    return { id: rows[0].id, counts: await countsInTx(t, tenant.timezone) };
  });
  if (!claimed) return 'ja_enviado';

  const { counts } = claimed;
  let delivery = 'nada_relevante';
  if (isRelevant(counts)) {
    delivery = 'so_painel';
    if (tenant.ownerWhatsapp && env.WA_DAILY_DIGEST_TEMPLATE && tenant.waPhoneNumberId) {
      try {
        await wa.sendTemplate(tenant, tenant.ownerWhatsapp, env.WA_DAILY_DIGEST_TEMPLATE, env.WA_OWNER_ALERT_TEMPLATE_LANG, [
          counts.quentesAguardando,
          counts.aguardando,
          counts.novosOntem,
          counts.visitasHoje,
          counts.avisos,
        ]);
        delivery = 'whatsapp';
      } catch (err) {
        delivery = 'falhou';
        logger.error({ tenantId: tenant.id, code: err.code }, 'Falha ao enviar o resumo diário');
      }
    }
  }
  await inTx(tenant.id, async (t) => {
    await sequelize.query('UPDATE aim_digest SET counts = CAST(:counts AS jsonb), delivery = :delivery, updated_at = now() WHERE id = :id', {
      replacements: { id: claimed.id, counts: JSON.stringify(counts), delivery },
      transaction: t,
    });
    if (delivery === 'whatsapp') await usage.add(tenant.id, { templatesSent: 1 }, t);
  });
  return delivery;
}

module.exports = { today, runDue, countsInTx, isRelevant, SEND_FROM_HOUR };
