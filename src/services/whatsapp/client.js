'use strict';

const crypto = require('crypto');
const env = require('../../config/env');
const logger = require('../../config/logger');
const AppError = require('../../errors/AppError');
const { decrypt } = require('../crypto');

const WA_MAX_TEXT = 4096;

/**
 * Token de acesso da conta: o próprio (cifrado no banco) ou, sem ele, o global do .env
 * (instalação de um cliente só). Nunca logar o retorno.
 */
function accessTokenFor(tenant) {
  if (tenant && tenant.waAccessTokenEnc) return decrypt(tenant.waAccessTokenEnc, tenant.id);
  if (env.WA_ACCESS_TOKEN) return env.WA_ACCESS_TOKEN;
  throw new AppError('WA_NOT_CONFIGURED', 'WhatsApp da conta não conectado', 409);
}

/** @param tenant conta com { id, waPhoneNumberId, waAccessTokenEnc? } */
async function callGraph(tenant, payload) {
  if (env.waMock) {
    // Simulação local: nada sai para a Meta. A mensagem fica só no banco (aparece no painel).
    logger.info({ type: payload.type, mock: true }, 'WhatsApp simulado (WA_MOCK=true)');
    return `mock-${crypto.randomUUID()}`;
  }
  if (!tenant || !tenant.waPhoneNumberId) {
    throw new AppError('WA_NOT_CONFIGURED', 'WhatsApp da conta não conectado', 409);
  }
  const token = accessTokenFor(tenant);
  const url = `https://graph.facebook.com/${env.WA_GRAPH_VERSION}/${encodeURIComponent(tenant.waPhoneNumberId)}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Loga só o código de erro da Meta, nunca o corpo da mensagem nem o telefone.
    logger.error({ status: res.status, waError: data?.error?.code, waSubcode: data?.error?.error_subcode }, 'Falha ao enviar WhatsApp');
    throw new AppError('WHATSAPP_SEND_FAILED', 'Falha ao enviar mensagem no WhatsApp', 502);
  }
  return data?.messages?.[0]?.id ?? null;
}

/** Mensagem de texto livre — só permitida dentro da janela de 24h após a última mensagem do lead. */
function sendText(tenant, to, body) {
  return callGraph(tenant, {
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body: String(body).slice(0, WA_MAX_TEXT) },
  });
}

/** Template aprovado — único jeito de iniciar conversa fora da janela de 24h. */
function sendTemplate(tenant, to, name, lang, bodyParams = []) {
  return callGraph(tenant, {
    to,
    type: 'template',
    template: {
      name,
      language: { code: lang },
      components: bodyParams.length
        ? [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t).slice(0, 200) })) }]
        : [],
    },
  });
}

module.exports = { sendText, sendTemplate, accessTokenFor };
