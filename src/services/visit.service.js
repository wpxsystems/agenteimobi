'use strict';

/**
 * Agendamento de visitas (item 2.3 do plano). Ver docs/logica/rotina-do-dono.md.
 *
 *   offerForLead : horários livres para a IA oferecer (grade da conta - visitas agendadas)
 *   bookInTx     : marca a visita dentro da transação do atendimento ou do painel.
 *                  Trava por conta (advisory lock): dois agendamentos simultâneos não pegam o mesmo horário.
 *                  A agenda é única por conta (imobiliária pequena: os mesmos corretores fazem todas as visitas).
 *   list / create / update : painel (agenda, remarcar, cancelar, realizada, não compareceu)
 *   sendDueReminders     : lembrete ao lead nas 24 h antes da visita
 */

const { QueryTypes } = require('sequelize');
const env = require('../config/env');
const logger = require('../config/logger');
const inTx = require('../db/inTx');
const AppError = require('../errors/AppError');
const { sequelize, Tenant, Lead, Property, Message } = require('../models');
const { parseSchedule, freeSlots, pickOffer } = require('./visit/slots');
const { slotLabel } = require('./time');
const wa = require('./whatsapp/client');
const usage = require('./usage.service');

const WINDOW_MS = 24 * 60 * 60 * 1000;
const HORIZON_DAYS = 7;

function scheduleOf(tenant) {
  try {
    return parseSchedule(tenant.visitSchedule);
  } catch {
    return null; // grade inválida ou vazia: sem oferta automática
  }
}

/** Visitas agendadas da conta a partir de agora (para excluir da oferta). Dentro de inTx. */
async function busyInTx(t, from = new Date()) {
  return sequelize.query(
    `SELECT starts_at AS start, ends_at AS "end" FROM aim_visit
      WHERE status = 'agendada' AND ends_at > :from`,
    { replacements: { from }, type: QueryTypes.SELECT, transaction: t }
  );
}

/** Até 6 horários livres, espalhados, para a IA oferecer. Dentro de inTx da conta. */
async function offerForLead(tenant, t, now = new Date()) {
  const schedule = scheduleOf(tenant);
  if (!schedule) return [];
  const busy = await busyInTx(t, now);
  const all = freeSlots({ schedule, busy, now, timezone: tenant.timezone, days: HORIZON_DAYS });
  return pickOffer(all, { timezone: tenant.timezone });
}

/** Todos os horários livres dos próximos dias (painel: agendar e remarcar). */
async function freeSlotsFor(tenantId, now = new Date()) {
  return inTx(tenantId, async (t) => {
    const tenant = await Tenant.findByPk(tenantId, { transaction: t });
    const schedule = scheduleOf(tenant);
    if (!schedule) return { timezone: tenant.timezone, slots: [] };
    const busy = await busyInTx(t, now);
    const slots = freeSlots({ schedule, busy, now, timezone: tenant.timezone, days: 14, minLeadMinutes: 60 });
    return { timezone: tenant.timezone, slots: slots.map((s) => ({ startsAt: s.toISOString(), label: slotLabel(s, tenant.timezone) })) };
  });
}

/**
 * Marca (ou move) a visita do lead. Se o lead já tem visita agendada, ela é remarcada.
 * @returns {{ ok: true, visit } | { ok: false, reason: 'ocupado'|'passado' }}
 */
async function bookInTx(t, { tenant, leadId, propertyId, startsAt, createdBy, ignoreVisitId = null }) {
  const schedule = scheduleOf(tenant);
  const minutes = schedule ? schedule.slotMinutes : 60;
  const start = new Date(startsAt);
  const end = new Date(start.getTime() + minutes * 60000);
  if (!(start.getTime() > Date.now())) return { ok: false, reason: 'passado' };

  // Uma agenda por conta: serializa agendamentos concorrentes da mesma conta.
  await sequelize.query("SELECT pg_advisory_xact_lock(hashtext('aim_visit:' || :tenantId))", {
    replacements: { tenantId: tenant.id },
    transaction: t,
  });
  const [clash] = await sequelize.query(
    `SELECT id FROM aim_visit
      WHERE status = 'agendada' AND starts_at < :end AND ends_at > :start
        AND lead_id <> :leadId AND (CAST(:ignore AS uuid) IS NULL OR id <> CAST(:ignore AS uuid))
      LIMIT 1`,
    { replacements: { start, end, leadId, ignore: ignoreVisitId }, type: QueryTypes.SELECT, transaction: t }
  );
  if (clash) return { ok: false, reason: 'ocupado' };

  const [existing] = await sequelize.query(`SELECT id FROM aim_visit WHERE lead_id = :leadId AND status = 'agendada' FOR UPDATE`, {
    replacements: { leadId },
    type: QueryTypes.SELECT,
    transaction: t,
  });
  let row;
  if (existing) {
    [row] = await sequelize.query(
      `UPDATE aim_visit SET starts_at = :start, ends_at = :end, property_id = :propertyId, reminder_sent_at = NULL, updated_at = now()
        WHERE id = :id RETURNING id, starts_at AS "startsAt", ends_at AS "endsAt", property_id AS "propertyId"`,
      { replacements: { id: existing.id, start, end, propertyId }, type: QueryTypes.SELECT, transaction: t }
    );
  } else {
    [row] = await sequelize.query(
      `INSERT INTO aim_visit (tenant_id, lead_id, property_id, starts_at, ends_at, created_by)
       VALUES (:tenantId, :leadId, :propertyId, :start, :end, :createdBy)
       RETURNING id, starts_at AS "startsAt", ends_at AS "endsAt", property_id AS "propertyId"`,
      { replacements: { tenantId: tenant.id, leadId, propertyId, start, end, createdBy }, type: QueryTypes.SELECT, transaction: t }
    );
  }
  return { ok: true, visit: { ...row, label: slotLabel(start, tenant.timezone) } };
}

const VISIT_COLUMNS = `v.id, v.starts_at AS "startsAt", v.ends_at AS "endsAt", v.status, v.created_by AS "createdBy",
  v.reminder_sent_at AS "reminderSentAt", v.lead_id AS "leadId", l.display_name AS "leadName", l.wa_id AS "leadPhone",
  l.anonymized_at IS NOT NULL AS "leadAnonymized", v.property_id AS "propertyId", p.code AS "propertyCode", p.title AS "propertyTitle"`;

/** Agenda: visitas de `from` até `to` (padrão: de hoje até 14 dias). */
async function list(tenantId, { from, to } = {}) {
  return inTx(tenantId, async (t) => {
    const tenant = await Tenant.findByPk(tenantId, { transaction: t });
    const rows = await sequelize.query(
      `SELECT ${VISIT_COLUMNS}
         FROM aim_visit v JOIN aim_lead l ON l.id = v.lead_id JOIN aim_property p ON p.id = v.property_id
        WHERE v.starts_at >= COALESCE(CAST(:from AS timestamptz), date_trunc('day', now() AT TIME ZONE :tz) AT TIME ZONE :tz)
          AND v.starts_at <  COALESCE(CAST(:to AS timestamptz), now() + interval '14 days')
        ORDER BY v.starts_at`,
      { replacements: { from: from || null, to: to || null, tz: tenant.timezone }, type: QueryTypes.SELECT, transaction: t }
    );
    return { timezone: tenant.timezone, visits: rows.map((r) => ({ ...r, label: slotLabel(new Date(r.startsAt), tenant.timezone) })) };
  });
}

/** Corretor agenda pelo painel (qualquer horário futuro sem conflito, dentro ou fora da grade). */
async function create(tenantId, { leadId, startsAt, propertyId }) {
  return inTx(tenantId, async (t) => {
    const tenant = await Tenant.findByPk(tenantId, { transaction: t });
    const lead = await Lead.findByPk(leadId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!lead) throw AppError.notFound('Lead');
    if (lead.anonymizedAt || lead.status === 'opt_out') throw new AppError('LEAD_UNAVAILABLE', 'Este lead não pode receber visita', 409);
    const pid = propertyId || lead.propertyId;
    if (!pid || !(await Property.findByPk(pid, { transaction: t }))) throw AppError.validation([{ path: 'propertyId', message: 'Informe o imóvel' }]);
    const r = await bookInTx(t, { tenant, leadId, propertyId: pid, startsAt, createdBy: 'corretor' });
    if (!r.ok) throw new AppError(r.reason === 'passado' ? 'VISIT_IN_PAST' : 'VISIT_CONFLICT', r.reason === 'passado' ? 'Escolha um horário futuro' : 'Já existe visita nesse horário', 409);
    await lead.update({ status: 'visita_agendada', visitPreference: r.visit.label, propertyId: pid }, { transaction: t });
    return r.visit;
  });
}

const FINAL = ['cancelada', 'realizada', 'nao_compareceu'];

/** Painel: mudar a situação ou remarcar. Só visita agendada muda. */
async function update(tenantId, id, { status, startsAt }) {
  return inTx(tenantId, async (t) => {
    const tenant = await Tenant.findByPk(tenantId, { transaction: t });
    const [v] = await sequelize.query(`SELECT id, lead_id AS "leadId", property_id AS "propertyId", status FROM aim_visit WHERE id = :id FOR UPDATE`, {
      replacements: { id },
      type: QueryTypes.SELECT,
      transaction: t,
    });
    if (!v) throw AppError.notFound('Visita');
    if (v.status !== 'agendada') throw new AppError('VISIT_CLOSED', 'Esta visita já foi encerrada', 409);
    if (startsAt) {
      const r = await bookInTx(t, { tenant, leadId: v.leadId, propertyId: v.propertyId, startsAt, createdBy: 'corretor', ignoreVisitId: v.id });
      if (!r.ok) throw new AppError(r.reason === 'passado' ? 'VISIT_IN_PAST' : 'VISIT_CONFLICT', r.reason === 'passado' ? 'Escolha um horário futuro' : 'Já existe visita nesse horário', 409);
      await Lead.update({ visitPreference: r.visit.label }, { where: { id: v.leadId }, transaction: t });
    }
    if (status && FINAL.includes(status)) {
      await sequelize.query('UPDATE aim_visit SET status = :status, updated_at = now() WHERE id = :id', { replacements: { id, status }, transaction: t });
      // Visita cancelada devolve o lead para o corretor decidir; as outras mantêm o lead como está.
      if (status === 'cancelada') {
        await Lead.update({ status: 'transferido' }, { where: { id: v.leadId, status: 'visita_agendada' }, transaction: t });
      }
    }
    return { id, status: status || 'agendada' };
  });
}

/**
 * Lembrete ao lead nas 24 h antes da visita (e com pelo menos 1 h de antecedência).
 * Dentro da janela de 24 h do WhatsApp vai texto livre; fora dela, só com template (WA_VISIT_REMINDER_TEMPLATE).
 * @returns {Promise<number>} lembretes enviados
 */
async function sendDueReminders(tenant, now = new Date()) {
  const due = await inTx(tenant.id, (t) =>
    sequelize.query(
      `SELECT ${VISIT_COLUMNS}, l.last_inbound_at AS "lastInboundAt"
         FROM aim_visit v JOIN aim_lead l ON l.id = v.lead_id JOIN aim_property p ON p.id = v.property_id
        WHERE v.status = 'agendada' AND v.reminder_sent_at IS NULL
          AND v.starts_at > :now::timestamptz + interval '1 hour'
          AND v.starts_at <= :now::timestamptz + interval '24 hours'
          AND l.anonymized_at IS NULL AND l.status <> 'opt_out'
        LIMIT 50`,
      { replacements: { now }, type: QueryTypes.SELECT, transaction: t }
    )
  );
  let sent = 0;
  for (const v of due) {
    const label = slotLabel(new Date(v.startsAt), tenant.timezone);
    const first = v.leadName ? `, ${String(v.leadName).split(' ')[0]}` : '';
    const text = `Oi${first}! Passando para lembrar da visita ao imóvel #${v.propertyCode} (${v.propertyTitle}) ${label}. Se precisar remarcar, é só responder aqui.`;
    const insideWindow = v.lastInboundAt && now.getTime() - new Date(v.lastInboundAt).getTime() < WINDOW_MS - 10 * 60000;
    try {
      let body;
      if (insideWindow) {
        await wa.sendText(tenant, v.leadPhone, text);
        body = text;
      } else if (env.WA_VISIT_REMINDER_TEMPLATE) {
        await wa.sendTemplate(tenant, v.leadPhone, env.WA_VISIT_REMINDER_TEMPLATE, env.WA_OWNER_ALERT_TEMPLATE_LANG, [
          v.leadName || 'tudo bem',
          `#${v.propertyCode}`,
          label,
        ]);
        body = `[lembrete de visita por template] ${label}`;
      } else {
        continue; // fora da janela e sem template: não há como avisar
      }
      await inTx(tenant.id, async (t) => {
        await Message.create({ tenantId: tenant.id, leadId: v.leadId, direction: 'out', author: 'system', msgType: 'text', body }, { transaction: t });
        await sequelize.query('UPDATE aim_visit SET reminder_sent_at = now(), updated_at = now() WHERE id = :id', { replacements: { id: v.id }, transaction: t });
        if (!insideWindow) await usage.add(tenant.id, { templatesSent: 1 }, t);
      });
      sent += 1;
    } catch (err) {
      logger.error({ tenantId: tenant.id, visitId: v.id, code: err.code }, 'Falha ao enviar lembrete de visita');
    }
  }
  return sent;
}

/** Grade da conta (admin). Valida antes de gravar. */
async function setSchedule(tenantId, schedule) {
  let parsed;
  try {
    parsed = parseSchedule(schedule);
  } catch (err) {
    throw AppError.validation([{ path: 'schedule', message: err.message }]);
  }
  const stored = { slotMinutes: parsed.slotMinutes, days: Object.fromEntries(Object.entries(parsed.days).filter(([, r]) => r.length).map(([k, r]) => [k, r.map((x) => x.text)])) };
  await inTx(tenantId, (t) =>
    sequelize.query('UPDATE aim_tenant SET visit_schedule = CAST(:s AS jsonb), updated_at = now() WHERE id = :tenantId', {
      replacements: { s: JSON.stringify(stored), tenantId },
      transaction: t,
    })
  );
  return stored;
}

module.exports = { offerForLead, freeSlotsFor, bookInTx, list, create, update, sendDueReminders, setSchedule, scheduleOf };
