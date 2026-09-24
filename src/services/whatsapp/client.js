'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const AppError = require('../../errors/AppError');

const WA_MAX_TEXT = 4096;

async function callGraph(phoneNumberId, payload) {
  const url = `https://graph.facebook.com/${env.WA_GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WA_ACCESS_TOKEN}`,
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
function sendText(phoneNumberId, to, body) {
  return callGraph(phoneNumberId, {
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body: String(body).slice(0, WA_MAX_TEXT) },
  });
}

/** Template aprovado — único jeito de iniciar conversa fora da janela de 24h. */
function sendTemplate(phoneNumberId, to, name, lang, bodyParams = []) {
  return callGraph(phoneNumberId, {
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

module.exports = { sendText, sendTemplate };
