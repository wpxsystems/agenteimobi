'use strict';

/**
 * Grade de horários de visita e horários livres. Funções puras (sem banco).
 *
 * Grade (aim_tenant.visit_schedule):
 *   { slotMinutes: 30|45|60|90|120, days: { "0": [...], ..., "6": ["09:00-12:00", "14:00-18:00"] } }
 *   0 = domingo. Dia ausente ou lista vazia = sem visitas nesse dia.
 */

const { localParts, zonedToUtc, addDays } = require('../time');

const SLOT_MINUTES = [30, 45, 60, 90, 120];
const RANGE_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_RANGES_PER_DAY = 4;

const toMinutes = (h, m) => Number(h) * 60 + Number(m);

/**
 * Valida e normaliza a grade. Lança Error com mensagem em português se inválida.
 * @returns {{ slotMinutes: number, days: Record<string, Array<{ start: number, end: number, text: string }>> }}
 */
function parseSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') throw new Error('Grade de horários ausente');
  const slotMinutes = Number(schedule.slotMinutes);
  if (!SLOT_MINUTES.includes(slotMinutes)) throw new Error(`Duração da visita deve ser ${SLOT_MINUTES.join(', ')} minutos`);
  const days = {};
  const input = schedule.days && typeof schedule.days === 'object' ? schedule.days : {};
  for (const key of Object.keys(input)) {
    if (!/^[0-6]$/.test(key)) throw new Error(`Dia inválido: ${key}`);
  }
  for (let wd = 0; wd <= 6; wd += 1) {
    const list = input[String(wd)] || [];
    if (!Array.isArray(list) || list.length > MAX_RANGES_PER_DAY) throw new Error(`No máximo ${MAX_RANGES_PER_DAY} faixas por dia`);
    const ranges = list.map((text) => {
      const m = RANGE_RE.exec(String(text).trim());
      if (!m) throw new Error(`Faixa inválida: "${text}". Use o formato 09:00-12:00`);
      const start = toMinutes(m[1], m[2]);
      const end = toMinutes(m[3], m[4]);
      if (end - start < slotMinutes) throw new Error(`A faixa ${text} é menor que a duração da visita`);
      return { start, end, text: String(text).trim() };
    });
    ranges.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i += 1) {
      if (ranges[i].start < ranges[i - 1].end) throw new Error(`Faixas sobrepostas: ${ranges[i - 1].text} e ${ranges[i].text}`);
    }
    days[String(wd)] = ranges;
  }
  return { slotMinutes, days };
}

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

/**
 * Horários livres (início de cada visita), em ordem.
 * @param {object} p
 * @param {object} p.schedule     grade (bruta ou já normalizada)
 * @param {Array<{start: Date, end: Date}>} p.busy  visitas agendadas da conta
 * @param {Date}   p.now
 * @param {string} p.timezone
 * @param {number} [p.days=7]              quantos dias de calendário olhar, contando hoje
 * @param {number} [p.minLeadMinutes=120]  antecedência mínima
 * @returns {Date[]}
 */
function freeSlots({ schedule, busy = [], now, timezone, days = 7, minLeadMinutes = 120 }) {
  const sch = schedule.days && Object.values(schedule.days).every((d) => Array.isArray(d) && (d.length === 0 || typeof d[0] === 'object'))
    ? schedule
    : parseSchedule(schedule);
  const earliest = now.getTime() + minLeadMinutes * 60000;
  const today = localParts(now, timezone);
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const day = addDays(today, i);
    for (const r of sch.days[String(day.weekday)] || []) {
      for (let t = r.start; t + sch.slotMinutes <= r.end; t += sch.slotMinutes) {
        const start = zonedToUtc({ y: day.y, m: day.m, d: day.d, h: Math.floor(t / 60), mi: t % 60 }, timezone);
        const end = new Date(start.getTime() + sch.slotMinutes * 60000);
        if (start.getTime() < earliest) continue;
        if (busy.some((b) => overlaps(start.getTime(), end.getTime(), new Date(b.start).getTime(), new Date(b.end).getTime()))) continue;
        out.push(start);
      }
    }
  }
  return out;
}

/**
 * Escolhe poucos horários espalhados para oferecer ao lead: no máximo `perDay` por dia
 * (um de manhã e um à tarde, quando houver), até `max` no total.
 */
function pickOffer(slots, { timezone, max = 6, perDay = 2 }) {
  const byDay = new Map();
  for (const s of slots) {
    const p = localParts(s, timezone);
    const key = `${p.y}-${p.m}-${p.d}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push({ s, h: p.h });
  }
  const out = [];
  for (const list of byDay.values()) {
    const morning = list.find((x) => x.h < 12);
    const afternoon = list.find((x) => x.h >= 12);
    const chosen = [morning, afternoon].filter(Boolean);
    for (const x of list) {
      if (chosen.length >= perDay) break;
      if (!chosen.includes(x)) chosen.push(x);
    }
    chosen.sort((a, b) => a.s - b.s);
    for (const x of chosen.slice(0, perDay)) {
      if (out.length >= max) return out;
      out.push(x.s);
    }
  }
  return out;
}

module.exports = { parseSchedule, freeSlots, pickOffer, SLOT_MINUTES };
