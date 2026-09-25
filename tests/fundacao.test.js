'use strict';

// Fase 0 do plano (sem banco): criptografia do token, regras da fila, contadores de uso e token por conta.

const crypto = require('crypto');
const { encrypt, decrypt } = require('../src/services/crypto');
const { retryDelayMs, errorLabel } = require('../src/services/job.service');
const { normalizeDelta } = require('../src/services/usage.service');
const { accessTokenFor } = require('../src/services/whatsapp/client');
const env = require('../src/config/env');

const KEY = crypto.randomBytes(32).toString('hex');
const OTHER_KEY = crypto.randomBytes(32).toString('hex');
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

describe('criptografia do token', () => {
  test('cifra e decifra com a mesma chave e a mesma conta', () => {
    const enc = encrypt('EAAG-token-da-meta', TENANT_A, KEY);
    expect(enc).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(enc).not.toContain('EAAG');
    expect(decrypt(enc, TENANT_A, KEY)).toBe('EAAG-token-da-meta');
  });

  test('IV aleatório: o mesmo texto gera cifras diferentes', () => {
    expect(encrypt('abc', TENANT_A, KEY)).not.toBe(encrypt('abc', TENANT_A, KEY));
  });

  test('cifra copiada para outra conta não decifra', () => {
    const enc = encrypt('segredo', TENANT_A, KEY);
    expect(() => decrypt(enc, TENANT_B, KEY)).toThrow(expect.objectContaining({ code: 'CRYPTO_DECRYPT_FAILED' }));
  });

  test('chave errada ou cifra adulterada não decifra', () => {
    const enc = encrypt('segredo', TENANT_A, KEY);
    expect(() => decrypt(enc, TENANT_A, OTHER_KEY)).toThrow(expect.objectContaining({ code: 'CRYPTO_DECRYPT_FAILED' }));
    const [v, iv, tag, data] = enc.split('.');
    const flipped = Buffer.from(data, 'base64url');
    flipped[0] ^= 1;
    const tampered = [v, iv, tag, flipped.toString('base64url')].join('.');
    expect(() => decrypt(tampered, TENANT_A, KEY)).toThrow(expect.objectContaining({ code: 'CRYPTO_DECRYPT_FAILED' }));
  });

  test('formato inválido, chave ausente e valor vazio', () => {
    expect(() => decrypt('texto-puro', TENANT_A, KEY)).toThrow(expect.objectContaining({ code: 'CRYPTO_INVALID_FORMAT' }));
    expect(() => decrypt('v2.a.b.c', TENANT_A, KEY)).toThrow(expect.objectContaining({ code: 'CRYPTO_INVALID_FORMAT' }));
    expect(() => encrypt('x', TENANT_A, 'curta')).toThrow(expect.objectContaining({ code: 'CRYPTO_KEY_MISSING' }));
    expect(() => encrypt('', TENANT_A, KEY)).toThrow(expect.objectContaining({ code: 'CRYPTO_INVALID_INPUT' }));
  });
});

describe('token do WhatsApp por conta', () => {
  test('conta com token próprio usa o dela, decifrado com o id da conta', () => {
    const enc = encrypt('token-da-conta-a', TENANT_A);
    expect(accessTokenFor({ id: TENANT_A, waAccessTokenEnc: enc })).toBe('token-da-conta-a');
  });

  test('conta sem token usa o global; sem nenhum, erro claro', () => {
    const original = env.WA_ACCESS_TOKEN;
    try {
      env.WA_ACCESS_TOKEN = 'token-global';
      expect(accessTokenFor({ id: TENANT_A, waAccessTokenEnc: null })).toBe('token-global');
      env.WA_ACCESS_TOKEN = '';
      expect(() => accessTokenFor({ id: TENANT_A })).toThrow(expect.objectContaining({ code: 'WA_NOT_CONFIGURED' }));
    } finally {
      env.WA_ACCESS_TOKEN = original;
    }
  });

  test('token de outra conta gravado por engano não decifra', () => {
    const enc = encrypt('token-da-conta-a', TENANT_A);
    expect(() => accessTokenFor({ id: TENANT_B, waAccessTokenEnc: enc })).toThrow(expect.objectContaining({ code: 'CRYPTO_DECRYPT_FAILED' }));
  });

  test('toJSON da conta não expõe o token cifrado', () => {
    const { Tenant } = require('../src/models');
    const t = Tenant.build({ id: TENANT_A, slug: 'conta-a', waAccessTokenEnc: 'v1.a.b.c', waWabaId: '123456' });
    expect(t.toJSON()).not.toHaveProperty('waAccessTokenEnc');
    expect(t.toJSON().waWabaId).toBe('123456');
    expect(JSON.stringify(t)).not.toContain('v1.a.b.c');
  });
});

describe('fila de jobs: regras puras', () => {
  test('espera entre tentativas: 5 s, 10 s, 20 s, 40 s... limitada a 10 min', () => {
    expect(retryDelayMs(1)).toBe(5000);
    expect(retryDelayMs(2)).toBe(10000);
    expect(retryDelayMs(3)).toBe(20000);
    expect(retryDelayMs(4)).toBe(40000);
    expect(retryDelayMs(10)).toBe(600000);
    expect(retryDelayMs(0)).toBe(5000);
    expect(retryDelayMs(undefined)).toBe(5000);
  });

  test('last_error guarda só o código, nunca a mensagem (pode ter dado do lead)', () => {
    const err = Object.assign(new Error('Falha ao enviar para 5511999999999: texto do lead'), { code: 'WHATSAPP_SEND_FAILED' });
    expect(errorLabel(err)).toBe('WHATSAPP_SEND_FAILED');
    expect(errorLabel(new TypeError('x'))).toBe('ERRO (TypeError)');
    expect(errorLabel(null)).toBe('ERRO');
    expect(errorLabel(new Error('com telefone 5511988887777'))).not.toMatch(/\d{8,}/);
  });
});

describe('contadores de uso', () => {
  test('completa com zero os contadores não informados', () => {
    expect(normalizeDelta({ aiCalls: 1 })).toEqual({ conversations: 0, aiCalls: 1, templatesSent: 0, adCopies: 0 });
  });

  test('rejeita incremento negativo, fracionário e contador desconhecido', () => {
    expect(() => normalizeDelta({ aiCalls: -1 })).toThrow(TypeError);
    expect(() => normalizeDelta({ aiCalls: 1.5 })).toThrow(TypeError);
    expect(() => normalizeDelta({ aiCalls: '1' })).toThrow(TypeError);
    expect(() => normalizeDelta({ tokens: 10 })).toThrow(TypeError);
  });
});
