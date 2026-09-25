'use strict';

/**
 * Cifra de segredos guardados no banco (token do WhatsApp por conta).
 * AES-256-GCM com IV aleatório de 12 bytes. O `aad` (dado autenticado, ex.: id da conta) amarra
 * a cifra ao registro: o mesmo texto cifrado copiado para outra conta não decifra.
 * Formato: "v1.<iv>.<tag>.<cifra>", partes em base64url.
 * Nunca logar o valor decifrado.
 */

const crypto = require('crypto');
const env = require('../config/env');
const AppError = require('../errors/AppError');

const ALG = 'aes-256-gcm';
const VERSION = 'v1';

function resolveKey(hexKey = env.WA_TOKEN_ENC_KEY) {
  if (!hexKey || !/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new AppError('CRYPTO_KEY_MISSING', 'Chave de criptografia não configurada', 500);
  }
  return Buffer.from(hexKey, 'hex');
}

function encrypt(plain, aad, hexKey) {
  if (typeof plain !== 'string' || !plain) throw new AppError('CRYPTO_INVALID_INPUT', 'Valor vazio', 500);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, resolveKey(hexKey), iv);
  cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
}

function decrypt(blob, aad, hexKey) {
  const parts = typeof blob === 'string' ? blob.split('.') : [];
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new AppError('CRYPTO_INVALID_FORMAT', 'Segredo cifrado em formato inválido', 500);
  }
  const [, iv, tag, data] = parts;
  try {
    const decipher = crypto.createDecipheriv(ALG, resolveKey(hexKey), Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch (err) {
    if (err instanceof AppError) throw err;
    // Chave errada, cifra adulterada ou aad de outra conta. Não repassa detalhe do erro.
    throw new AppError('CRYPTO_DECRYPT_FAILED', 'Não foi possível decifrar o segredo', 500);
  }
}

module.exports = { encrypt, decrypt };
