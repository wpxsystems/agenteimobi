'use strict';

/**
 * Fuso horário sem biblioteca: converte entre "hora local da conta" e instantes (Date/UTC) usando Intl.
 * Funções puras. O Brasil não tem horário de verão desde 2019, mas a conversão trata a troca de offset
 * mesmo assim (segunda passada), para fusos que ainda têm.
 */

const partsCache = new Map();
function formatter(tz) {
  if (!partsCache.has(tz)) {
    partsCache.set(
      tz,
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
      })
    );
  }
  return partsCache.get(tz);
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !/^[A-Za-z_]+(\/[A-Za-z_]+){1,2}$/.test(tz)) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Partes da data na hora local do fuso: { y, m, d, h, mi, weekday (0 = domingo) }. */
function localParts(date, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(date).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second), weekday: WEEKDAYS[p.weekday] };
}

/** Diferença (ms) entre a hora local do fuso e UTC naquele instante. São Paulo = -3 h. */
function offsetMs(date, tz) {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Instante correspondente a uma hora local do fuso. */
function zonedToUtc({ y, m, d, h = 0, mi = 0 }, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - offsetMs(new Date(guess), tz);
  const second = guess - offsetMs(new Date(first), tz);
  return new Date(second);
}

/** "AAAA-MM-DD" da data local. */
function localDate(date, tz) {
  const p = localParts(date, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Soma dias de calendário a { y, m, d } (sem fuso: aritmética de calendário). */
function addDays({ y, m, d }, n) {
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate(), weekday: x.getUTCDay() };
}

const WEEKDAY_PT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** "qua 01/10 às 10:00" na hora local do fuso. */
function slotLabel(date, tz) {
  const p = localParts(date, tz);
  const dd = String(p.d).padStart(2, '0');
  const mm = String(p.m).padStart(2, '0');
  const hh = String(p.h).padStart(2, '0');
  const mi = String(p.mi).padStart(2, '0');
  return `${WEEKDAY_PT[p.weekday]} ${dd}/${mm} às ${hh}:${mi}`;
}

module.exports = { isValidTimezone, localParts, offsetMs, zonedToUtc, localDate, addDays, slotLabel };
