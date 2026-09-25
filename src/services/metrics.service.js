'use strict';

const { QueryTypes } = require('sequelize');
const inTx = require('../db/inTx');
const { sequelize } = require('../models');

const rate = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null); // % com 1 casa

/**
 * Funil: cliques no link -> conversas -> qualificados -> transferidos -> visitas.
 * Todas as taxas são calculadas aqui (backend), nunca recebidas do cliente.
 */
async function funnel(tenantId, { propertyId, from, to }) {
  const replacements = {
    propertyId: propertyId || null,
    from: from || '1970-01-01T00:00:00Z',
    to: to || '9999-12-31T00:00:00Z',
  };

  const [row] = await inTx(tenantId, (t) =>
    sequelize.query(
      `SELECT
         (SELECT count(*) FROM aim_link_click c
           WHERE (:propertyId::uuid IS NULL OR c.property_id = :propertyId::uuid)
             AND c.created_at >= :from::timestamptz AND c.created_at < :to::timestamptz)::int AS clicks,
         count(l.*)::int                                                          AS leads,
         count(*) FILTER (WHERE l.classification = 'quente')::int                 AS quentes,
         count(*) FILTER (WHERE l.classification = 'morno')::int                  AS mornos,
         count(*) FILTER (WHERE l.classification = 'frio')::int                   AS frios,
         count(*) FILTER (WHERE l.classification = 'indefinido')::int             AS indefinidos,
         count(*) FILTER (WHERE l.handoff_at IS NOT NULL)::int                    AS transferidos,
         count(*) FILTER (WHERE l.status = 'visita_agendada' OR EXISTS (SELECT 1 FROM aim_visit v WHERE v.lead_id = l.id AND v.status <> 'cancelada'))::int AS visitas
       FROM aim_lead l
       WHERE (:propertyId::uuid IS NULL OR l.property_id = :propertyId::uuid)
         AND l.created_at >= :from::timestamptz AND l.created_at < :to::timestamptz`,
      { replacements, type: QueryTypes.SELECT, transaction: t }
    )
  );

  return {
    ...row,
    taxas: {
      cliqueParaConversa: rate(row.leads, row.clicks),
      conversaParaQualificado: rate(row.quentes + row.mornos, row.leads),
      conversaParaVisita: rate(row.visitas, row.leads),
    },
  };
}

const TZ = 'America/Sao_Paulo';
const DAY_MS = 86400000;
const dayKey = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD no fuso da operação

/** Lista os dias (YYYY-MM-DD, fuso de São Paulo) entre dois instantes, inclusive, limitado a maxDays. */
function listDays(from, to, maxDays = 366) {
  const out = [];
  const end = new Date(`${dayKey(to)}T12:00:00Z`);
  for (let d = new Date(`${dayKey(from)}T12:00:00Z`); d <= end && out.length < maxDays; d = new Date(d.getTime() + DAY_MS)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Visão geral do funil para o painel: funil + série diária + por imóvel + por origem +
 * motivos de desqualificação + leads transferidos aguardando o corretor + tempo até transferir.
 * Todos os números vêm do banco, sob RLS; nada é recebido do cliente além dos filtros.
 */
async function overview(tenantId, { propertyId, from, to }) {
  const now = new Date();
  const tlFrom = from ? new Date(from) : new Date(now.getTime() - 89 * DAY_MS);
  const tlTo = to ? new Date(to) : now;
  const replacements = {
    propertyId: propertyId || null,
    from: from || '1970-01-01T00:00:00Z',
    to: to || '9999-12-31T00:00:00Z',
    tlFrom: tlFrom.toISOString(),
    tlTo: tlTo.toISOString(),
    tz: TZ,
  };
  const q = (t, sql) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction: t });

  const funil = await funnel(tenantId, { propertyId, from, to });

  const data = await inTx(tenantId, async (t) => {
    const clicksByDay = await q(
      t,
      `SELECT to_char(created_at AT TIME ZONE :tz, 'YYYY-MM-DD') AS dia, count(*)::int AS n
         FROM aim_link_click
        WHERE (:propertyId::uuid IS NULL OR property_id = :propertyId::uuid)
          AND created_at >= :tlFrom::timestamptz AND created_at <= :tlTo::timestamptz
        GROUP BY 1`
    );
    const leadsByDay = await q(
      t,
      `SELECT to_char(created_at AT TIME ZONE :tz, 'YYYY-MM-DD') AS dia, count(*)::int AS n
         FROM aim_lead
        WHERE (:propertyId::uuid IS NULL OR property_id = :propertyId::uuid)
          AND created_at >= :tlFrom::timestamptz AND created_at <= :tlTo::timestamptz
        GROUP BY 1`
    );
    const byProperty = await q(
      t,
      `SELECT p.id, p.code, p.title, p.is_active AS "isActive",
              (SELECT count(*) FROM aim_link_click c
                WHERE c.property_id = p.id AND c.created_at >= :from::timestamptz AND c.created_at < :to::timestamptz)::int AS clicks,
              count(l.id)::int AS leads,
              count(l.id) FILTER (WHERE l.classification = 'quente')::int AS quentes,
              count(l.id) FILTER (WHERE l.classification = 'morno')::int AS mornos,
              count(l.id) FILTER (WHERE l.classification = 'frio')::int AS frios,
              count(l.id) FILTER (WHERE l.classification = 'indefinido')::int AS indefinidos,
              count(l.id) FILTER (WHERE l.handoff_at IS NOT NULL)::int AS transferidos,
              count(l.id) FILTER (WHERE l.status = 'visita_agendada' OR EXISTS (SELECT 1 FROM aim_visit v WHERE v.lead_id = l.id AND v.status <> 'cancelada'))::int AS visitas
         FROM aim_property p
         LEFT JOIN aim_lead l ON l.property_id = p.id AND l.created_at >= :from::timestamptz AND l.created_at < :to::timestamptz
        GROUP BY p.id
        ORDER BY leads DESC, clicks DESC, p.code`
    );
    const clicksBySource = await q(
      t,
      `SELECT coalesce(source, 'sem origem') AS source, count(*)::int AS n
         FROM aim_link_click
        WHERE (:propertyId::uuid IS NULL OR property_id = :propertyId::uuid)
          AND created_at >= :from::timestamptz AND created_at < :to::timestamptz
        GROUP BY 1 ORDER BY 2 DESC LIMIT 8`
    );
    const leadsBySource = await q(
      t,
      `SELECT coalesce(source, 'desconhecido') AS source, count(*)::int AS n
         FROM aim_lead
        WHERE (:propertyId::uuid IS NULL OR property_id = :propertyId::uuid)
          AND created_at >= :from::timestamptz AND created_at < :to::timestamptz
        GROUP BY 1 ORDER BY 2 DESC LIMIT 8`
    );
    const disqualify = await q(
      t,
      `SELECT r AS reason, count(DISTINCT l.id)::int AS leads
         FROM aim_lead l CROSS JOIN LATERAL unnest(l.disqualify_reasons) AS r
        WHERE (:propertyId::uuid IS NULL OR l.property_id = :propertyId::uuid)
          AND l.created_at >= :from::timestamptz AND l.created_at < :to::timestamptz
        GROUP BY r ORDER BY leads DESC`
    );
    // Estado atual (não depende do período): transferidos sem nenhuma resposta humana depois do handoff.
    const awaiting = await q(
      t,
      `SELECT l.id, l.display_name AS "displayName", l.wa_id AS "waId", l.classification, l.handoff_at AS "handoffAt", p.code AS "propertyCode"
         FROM aim_lead l LEFT JOIN aim_property p ON p.id = l.property_id
        WHERE l.status = 'transferido'
          AND (:propertyId::uuid IS NULL OR l.property_id = :propertyId::uuid)
          AND NOT EXISTS (SELECT 1 FROM aim_message m
                           WHERE m.lead_id = l.id AND m.author = 'human' AND m.created_at >= coalesce(l.handoff_at, l.updated_at))
        ORDER BY l.handoff_at ASC NULLS LAST
        LIMIT 20`
    );
    const [handoffTime] = await q(
      t,
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (handoff_at - created_at)) / 60) AS "medianMinutes",
              count(*)::int AS n
         FROM aim_lead
        WHERE handoff_at IS NOT NULL
          AND (:propertyId::uuid IS NULL OR property_id = :propertyId::uuid)
          AND created_at >= :from::timestamptz AND created_at < :to::timestamptz`
    );
    // Atendimento: mensagens por dia e por autor (lead / assistente / corretor / sistema)
    const messagesByDay = await q(
      t,
      `SELECT to_char(m.created_at AT TIME ZONE :tz, 'YYYY-MM-DD') AS dia, m.author, count(*)::int AS n
         FROM aim_message m JOIN aim_lead l ON l.id = m.lead_id
        WHERE (:propertyId::uuid IS NULL OR l.property_id = :propertyId::uuid)
          AND m.created_at >= :tlFrom::timestamptz AND m.created_at <= :tlTo::timestamptz
        GROUP BY 1, 2`
    );
    const messageTotals = await q(
      t,
      `SELECT m.author, count(*)::int AS n
         FROM aim_message m JOIN aim_lead l ON l.id = m.lead_id
        WHERE (:propertyId::uuid IS NULL OR l.property_id = :propertyId::uuid)
          AND m.created_at >= :from::timestamptz AND m.created_at < :to::timestamptz
        GROUP BY 1`
    );
    const [botOnly] = await q(
      t,
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM aim_message m WHERE m.lead_id = l.id AND m.author = 'human'))::int AS "semHumano"
         FROM aim_lead l
        WHERE (:propertyId::uuid IS NULL OR l.property_id = :propertyId::uuid)
          AND l.created_at >= :from::timestamptz AND l.created_at < :to::timestamptz`
    );
    const openQuestionsTop = await q(
      t,
      `SELECT min(q.question) AS question, p.code AS "propertyCode", count(DISTINCT l.id)::int AS leads
         FROM aim_lead l
         CROSS JOIN LATERAL jsonb_array_elements_text(l.open_questions) AS q(question)
         LEFT JOIN aim_property p ON p.id = l.property_id
        WHERE (:propertyId::uuid IS NULL OR l.property_id = :propertyId::uuid)
          AND l.created_at >= :from::timestamptz AND l.created_at < :to::timestamptz
        GROUP BY lower(q.question), p.code
        ORDER BY leads DESC, question
        LIMIT 10`
    );
    return { clicksByDay, leadsByDay, byProperty, clicksBySource, leadsBySource, disqualify, awaiting, handoffTime, messagesByDay, messageTotals, botOnly, openQuestionsTop };
  });

  const AUTHORS = ['lead', 'bot', 'human', 'system'];
  const porDia = new Map();
  for (const r of data.messagesByDay) {
    if (!porDia.has(r.dia)) porDia.set(r.dia, Object.fromEntries(AUTHORS.map((a) => [a, 0])));
    porDia.get(r.dia)[r.author] = r.n;
  }
  const totals = Object.fromEntries(AUTHORS.map((a) => [a, 0]));
  for (const r of data.messageTotals) totals[r.author] = r.n;

  const clicksMap = new Map(data.clicksByDay.map((r) => [r.dia, r.n]));
  const leadsMap = new Map(data.leadsByDay.map((r) => [r.dia, r.n]));
  const days = listDays(tlFrom, tlTo).map((date) => ({ date, clicks: clicksMap.get(date) || 0, leads: leadsMap.get(date) || 0 }));

  return {
    funnel: funil,
    timeline: { from: days[0]?.date ?? null, to: days[days.length - 1]?.date ?? null, days },
    byProperty: data.byProperty.map((r) => ({ ...r, taxaCliqueParaConversa: rate(r.leads, r.clicks) })),
    bySource: { clicks: data.clicksBySource, leads: data.leadsBySource },
    disqualify: data.disqualify,
    awaiting: data.awaiting.map((r) => ({
      ...r,
      waitingMinutes: r.handoffAt ? Math.max(0, Math.round((now - new Date(r.handoffAt)) / 60000)) : null,
    })),
    handoff: {
      medianMinutes: data.handoffTime?.medianMinutes === null || data.handoffTime?.medianMinutes === undefined ? null : Math.round(Number(data.handoffTime.medianMinutes)),
      count: data.handoffTime?.n ?? 0,
    },
    messages: {
      byDay: listDays(tlFrom, tlTo).map((date) => ({ date, ...(porDia.get(date) || Object.fromEntries(AUTHORS.map((a) => [a, 0]))) })),
      totals,
      leads: data.botOnly?.total ?? 0,
      botOnly: data.botOnly?.semHumano ?? 0,
      botOnlyRate: rate(data.botOnly?.semHumano ?? 0, data.botOnly?.total ?? 0),
    },
    openQuestionsTop: data.openQuestionsTop,
  };
}

module.exports = { funnel, overview, _internals: { listDays, dayKey } };
