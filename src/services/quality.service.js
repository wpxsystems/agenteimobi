'use strict';

/**
 * Avisos de qualidade (item 2.2 do plano). Regras fixas, sem IA. Ver docs/logica/rotina-do-dono.md.
 *
 * Avisos por REGRA (recalculados a cada rodada; somem sozinhos quando a condição deixa de valer):
 *   lead_sem_retorno    : transferido e sem mensagem do corretor há mais de handoff_sla_minutes
 *   sem_resposta        : o lead escreveu, o bot está ligado e nada saiu há mais de 15 min (e menos de 24 h)
 *   cadastro_incompleto : 3+ leads com dúvida NOVA sem resposta sobre o imóvel desde a última edição dele
 *                         (aim_lead.open_questions_at: data da última dúvida nova do lead)
 *
 * Avisos por EVENTO (gravados quando acontecem; somem quando o lead volta a receber resposta):
 *   falha_envio / ia_invalida / falha_resposta : a resposta ao lead esgotou as tentativas na fila
 *
 * details guarda só números, códigos e as perguntas já agregadas do cadastro. Nunca texto de conversa.
 */

const { QueryTypes } = require('sequelize');
const inTx = require('../db/inTx');
const AppError = require('../errors/AppError');
const { sequelize, Tenant } = require('../models');

const RULE_KINDS = ['lead_sem_retorno', 'sem_resposta', 'cadastro_incompleto'];
const EVENT_KINDS = ['falha_envio', 'ia_invalida', 'falha_resposta'];
const NO_REPLY_MINUTES = 15;
const INCOMPLETE_MIN_LEADS = 3;

/** Tipo do aviso para um erro que esgotou as tentativas. */
function eventKindFor(errorCode) {
  if (errorCode === 'WHATSAPP_SEND_FAILED') return 'falha_envio';
  if (errorCode === 'AI_INVALID_OUTPUT') return 'ia_invalida';
  return 'falha_resposta';
}

const keyOf = (a) => `${a.kind}:${a.leadId || ''}:${a.propertyId || ''}`;

/**
 * O que criar e o que resolver, comparando os avisos abertos com as condições atuais. Função pura.
 * Só mexe nos tipos por regra; os de evento são tratados à parte.
 */
function diffAlerts(open, current) {
  const openRules = open.filter((a) => RULE_KINDS.includes(a.kind));
  const openKeys = new Map(openRules.map((a) => [keyOf(a), a]));
  const currentKeys = new Set(current.map(keyOf));
  return {
    toCreate: current.filter((c) => !openKeys.has(keyOf(c))),
    toResolve: openRules.filter((a) => !currentKeys.has(keyOf(a))).map((a) => a.id),
  };
}

/** Condições atuais das regras para uma conta. Dentro de inTx da conta. */
async function currentConditions(t, tenant) {
  const q = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction: t });
  const semRetorno = await q(
    `SELECT l.id AS "leadId", l.classification,
            floor(extract(epoch FROM (now() - l.handoff_at)) / 60)::int AS minutos
       FROM aim_lead l
      WHERE l.status = 'transferido' AND l.anonymized_at IS NULL AND l.handoff_at IS NOT NULL
        AND l.handoff_at < now() - make_interval(mins => :sla)
        AND NOT EXISTS (SELECT 1 FROM aim_message m WHERE m.lead_id = l.id AND m.author = 'human' AND m.created_at >= l.handoff_at)`,
    { sla: tenant.handoffSlaMinutes || 120 }
  );
  const semResposta = await q(
    `SELECT l.id AS "leadId", floor(extract(epoch FROM (now() - l.last_inbound_at)) / 60)::int AS minutos
       FROM aim_lead l
      WHERE l.bot_active AND l.anonymized_at IS NULL AND l.status IN ('novo', 'em_atendimento', 'visita_agendada')
        AND l.last_inbound_at > COALESCE(l.last_replied_inbound_at, '-infinity'::timestamptz)
        AND l.last_inbound_at < now() - make_interval(mins => :mins)
        AND l.last_inbound_at > now() - interval '24 hours'`,
    { mins: NO_REPLY_MINUTES }
  );
  const incompleto = await q(
    `SELECT p.id AS "propertyId", p.code, count(DISTINCT l.id)::int AS leads,
            (SELECT coalesce(jsonb_agg(x.q), '[]'::jsonb) FROM (
               SELECT min(q.question) AS q FROM aim_lead l2, jsonb_array_elements_text(l2.open_questions) AS q(question)
                WHERE l2.property_id = p.id AND l2.open_questions_at > p.updated_at
                GROUP BY lower(q.question) ORDER BY count(*) DESC LIMIT 5) x) AS perguntas
       FROM aim_property p
       JOIN aim_lead l ON l.property_id = p.id AND jsonb_array_length(l.open_questions) > 0 AND l.open_questions_at > p.updated_at
      WHERE p.is_active
      GROUP BY p.id, p.code
     HAVING count(DISTINCT l.id) >= :min`,
    { min: INCOMPLETE_MIN_LEADS }
  );
  return [
    ...semRetorno.map((r) => ({ kind: 'lead_sem_retorno', leadId: r.leadId, propertyId: null, details: { minutos: r.minutos, classificacao: r.classification } })),
    ...semResposta.map((r) => ({ kind: 'sem_resposta', leadId: r.leadId, propertyId: null, details: { minutos: r.minutos } })),
    ...incompleto.map((r) => ({ kind: 'cadastro_incompleto', leadId: null, propertyId: r.propertyId, details: { codigo: r.code, leads: r.leads, perguntas: r.perguntas } })),
  ];
}

/**
 * Recalcula os avisos de uma conta: cria os novos, resolve os que deixaram de valer
 * e atualiza os números (minutos esperando etc.) dos que continuam.
 * @returns {Promise<{ created: number, resolved: number }>}
 */
async function sync(tenant) {
  return inTx(tenant.id, async (t) => {
    const open = await sequelize.query(
      `SELECT id, kind, lead_id AS "leadId", property_id AS "propertyId", created_at AS "createdAt" FROM aim_alert WHERE resolved_at IS NULL FOR UPDATE`,
      { type: QueryTypes.SELECT, transaction: t }
    );
    const current = await currentConditions(t, tenant);
    const { toCreate, toResolve } = diffAlerts(open, current);

    for (const c of toCreate) {
      await sequelize.query(
        `INSERT INTO aim_alert (tenant_id, lead_id, property_id, kind, details) VALUES (:tenantId, :leadId, :propertyId, :kind, CAST(:details AS jsonb))
         ON CONFLICT DO NOTHING`,
        { replacements: { tenantId: tenant.id, leadId: c.leadId, propertyId: c.propertyId, kind: c.kind, details: JSON.stringify(c.details) }, transaction: t }
      );
    }
    if (toResolve.length) {
      await sequelize.query(`UPDATE aim_alert SET resolved_at = now(), resolved_by = 'automatico', updated_at = now() WHERE id IN (:ids)`, {
        replacements: { ids: toResolve },
        transaction: t,
      });
    }
    // Números atualizados nos que continuam abertos (ex.: minutos esperando).
    const openByKey = new Map(open.map((a) => [keyOf(a), a]));
    for (const c of current) {
      const a = openByKey.get(keyOf(c));
      if (a) {
        await sequelize.query('UPDATE aim_alert SET details = CAST(:details AS jsonb), updated_at = now() WHERE id = :id', {
          replacements: { id: a.id, details: JSON.stringify(c.details) },
          transaction: t,
        });
      }
    }
    // Eventos: somem quando o lead voltou a receber resposta, ou saiu do atendimento.
    const [, meta] = await sequelize.query(
      `UPDATE aim_alert a SET resolved_at = now(), resolved_by = 'automatico', updated_at = now()
         FROM aim_lead l
        WHERE a.lead_id = l.id AND a.resolved_at IS NULL AND a.kind IN (:events)
          AND (l.anonymized_at IS NOT NULL OR l.status IN ('opt_out', 'descartado')
               OR EXISTS (SELECT 1 FROM aim_message m WHERE m.lead_id = l.id AND m.direction = 'out' AND m.created_at > a.created_at))`,
      { replacements: { events: EVENT_KINDS }, transaction: t }
    );
    return { created: toCreate.length, resolved: toResolve.length + (meta?.rowCount || 0) };
  });
}

/** Aviso por evento (a resposta ao lead esgotou as tentativas). Dentro de inTx da conta. Idempotente. */
async function raiseEventInTx(t, { tenantId, leadId, errorCode, attempts }) {
  if (!leadId) return;
  await sequelize.query(
    `INSERT INTO aim_alert (tenant_id, lead_id, kind, details) VALUES (:tenantId, :leadId, :kind, CAST(:details AS jsonb))
     ON CONFLICT DO NOTHING`,
    { replacements: { tenantId, leadId, kind: eventKindFor(errorCode), details: JSON.stringify({ codigo: errorCode || null, tentativas: attempts || null }) }, transaction: t }
  );
}

/** Avisos abertos da conta, com o nome do lead e o código do imóvel. */
async function listOpen(tenantId) {
  return inTx(tenantId, (t) =>
    sequelize.query(
      `SELECT a.id, a.kind, a.details, a.created_at AS "createdAt", a.lead_id AS "leadId", l.display_name AS "leadName", l.wa_id AS "leadPhone",
              COALESCE(a.property_id, l.property_id) AS "propertyId", p.code AS "propertyCode"
         FROM aim_alert a
         LEFT JOIN aim_lead l ON l.id = a.lead_id
         LEFT JOIN aim_property p ON p.id = COALESCE(a.property_id, l.property_id)
        WHERE a.resolved_at IS NULL
        ORDER BY CASE a.kind WHEN 'lead_sem_retorno' THEN 0 WHEN 'sem_resposta' THEN 1 WHEN 'falha_envio' THEN 2 ELSE 3 END, a.created_at
        LIMIT 100`,
      { type: QueryTypes.SELECT, transaction: t }
    )
  );
}

async function resolve(tenantId, id) {
  const [, meta] = await inTx(tenantId, (t) =>
    sequelize.query(`UPDATE aim_alert SET resolved_at = now(), resolved_by = 'usuario', updated_at = now() WHERE id = :id AND resolved_at IS NULL`, {
      replacements: { id },
      transaction: t,
    })
  );
  if (!meta?.rowCount) throw AppError.notFound('Aviso');
}

/** Ao editar o imóvel, o aviso de cadastro incompleto some (as dúvidas passam a contar de novo a partir daqui). */
async function resolvePropertyInTx(t, propertyId) {
  await sequelize.query(
    `UPDATE aim_alert SET resolved_at = now(), resolved_by = 'automatico', updated_at = now()
      WHERE property_id = :propertyId AND kind = 'cadastro_incompleto' AND resolved_at IS NULL`,
    { replacements: { propertyId }, transaction: t }
  );
}

async function syncTenant(tenantId) {
  const tenant = await Tenant.findByPk(tenantId);
  if (tenant) await sync(tenant);
}

async function syncAll() {
  const tenants = await Tenant.findAll({ where: { isActive: true } });
  for (const tenant of tenants) await sync(tenant);
}

module.exports = { sync, syncTenant, syncAll, raiseEventInTx, listOpen, resolve, resolvePropertyInTx, diffAlerts, eventKindFor, RULE_KINDS, EVENT_KINDS };
