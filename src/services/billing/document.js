'use strict';

/**
 * CPF/CNPJ para a cobrança. Validado aqui, enviado ao provedor e NÃO guardado no banco.
 * Dígitos verificadores pelo algoritmo da Receita (módulo 11).
 */

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

function isValidCpf(value) {
  const d = onlyDigits(value);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i += 1) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

function isValidCnpj(value) {
  const d = onlyDigits(value);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (len) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, w, i) => acc + Number(d[i]) * w, 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

/** @returns {string|null} só os dígitos, se válido */
function normalizeDocument(value) {
  const d = onlyDigits(value);
  if (d.length === 11 && isValidCpf(d)) return d;
  if (d.length === 14 && isValidCnpj(d)) return d;
  return null;
}

module.exports = { isValidCpf, isValidCnpj, normalizeDocument };
