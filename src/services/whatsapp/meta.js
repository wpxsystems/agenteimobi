'use strict';

/**
 * Chamadas à Graph API da Meta para o cadastro incorporado do WhatsApp (Embedded Signup).
 * Escrito pela documentação da Meta; conferir com o app aprovado como Tech Provider antes de produção.
 *
 *   exchangeCode    : troca o "code" do login pelo token de negócio da empresa cliente
 *   subscribeApp    : assina o nosso app nos avisos (webhooks) da WABA do cliente
 *   registerNumber  : registra o número na Cloud API (exige um PIN de 6 dígitos da verificação em duas etapas)
 *   getPhoneInfo    : número exibido, nome verificado e qualidade
 *   unsubscribeApp  : desfaz a assinatura ao desconectar
 *
 * Nunca loga token, código nem telefone.
 */

const env = require('../../config/env');
const logger = require('../../config/logger');
const AppError = require('../../errors/AppError');

const graphUrl = (path) => `https://graph.facebook.com/${env.WA_GRAPH_VERSION}/${path}`;

async function graph(method, path, { token, body, query } = {}) {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
  const res = await fetch(graphUrl(path) + qs, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    logger.error({ status: res.status, metaError: data?.error?.code, metaSubcode: data?.error?.error_subcode, step: path.split('/').pop() }, 'Falha na Graph API (conexão do WhatsApp)');
    throw new AppError('WA_CONNECT_FAILED', 'A Meta recusou um passo da conexão. Tente de novo ou fale com o suporte.', 502);
  }
  return data;
}

async function exchangeCode(code) {
  const data = await graph('GET', 'oauth/access_token', {
    query: { client_id: env.META_APP_ID, client_secret: env.WA_APP_SECRET, code },
  });
  if (!data.access_token) throw new AppError('WA_CONNECT_FAILED', 'A Meta não devolveu o acesso da empresa', 502);
  return data.access_token;
}

const subscribeApp = (wabaId, token) => graph('POST', `${encodeURIComponent(wabaId)}/subscribed_apps`, { token });
const unsubscribeApp = (wabaId, token) => graph('DELETE', `${encodeURIComponent(wabaId)}/subscribed_apps`, { token });
const registerNumber = (phoneNumberId, token, pin) =>
  graph('POST', `${encodeURIComponent(phoneNumberId)}/register`, { token, body: { messaging_product: 'whatsapp', pin } });

async function getPhoneInfo(phoneNumberId, token) {
  const d = await graph('GET', encodeURIComponent(phoneNumberId), {
    token,
    query: { fields: 'display_phone_number,verified_name,quality_rating,messaging_limit_tier' },
  });
  return {
    displayPhone: String(d.display_phone_number || '').replace(/\D/g, ''),
    verifiedName: d.verified_name || null,
    quality: d.quality_rating || null,
    messagingLimit: d.messaging_limit_tier || null,
  };
}

module.exports = { exchangeCode, subscribeApp, unsubscribeApp, registerNumber, getPhoneInfo };
