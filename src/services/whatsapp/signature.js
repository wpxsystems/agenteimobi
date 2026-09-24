'use strict';

const crypto = require('crypto');

/**
 * Valida o header X-Hub-Signature-256 enviado pela Meta:
 *   "sha256=" + HMAC_SHA256(app_secret, corpo_bruto)
 * Precisa do corpo BRUTO (Buffer), antes de qualquer JSON.parse.
 */
function isValidSignature(rawBody, header, appSecret) {
  if (!Buffer.isBuffer(rawBody) || typeof header !== 'string' || !appSecret) return false;
  const [algo, received] = header.split('=');
  if (algo !== 'sha256' || !received || !/^[0-9a-f]{64}$/i.test(received)) return false;

  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(received.toLowerCase(), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { isValidSignature };
