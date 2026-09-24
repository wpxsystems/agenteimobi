'use strict';

/**
 * Normaliza o payload do webhook da WhatsApp Cloud API em uma lista plana de mensagens recebidas.
 * Formato de entrada: { object: 'whatsapp_business_account', entry: [{ changes: [{ value: {...} }] }] }
 * Status de entrega (value.statuses) são ignorados no MVP.
 */

const PROPERTY_CODE_RE = /#([A-Za-z0-9]{3,12})\b/;

function extractText(msg) {
  switch (msg.type) {
    case 'text':
      return msg.text?.body ?? '';
    case 'button':
      return msg.button?.text ?? '';
    case 'interactive':
      return msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? '';
    default:
      return '';
  }
}

function parseWebhook(payload) {
  const out = [];
  if (!payload || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) {
    return out;
  }
  for (const entry of payload.entry) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId || !Array.isArray(value.messages)) continue;

      const names = new Map((value.contacts || []).map((c) => [c.wa_id, c.profile?.name ?? null]));

      for (const msg of value.messages) {
        if (!msg?.id || !msg?.from || !/^[0-9]{8,15}$/.test(msg.from)) continue;
        out.push({
          phoneNumberId: String(phoneNumberId),
          waMessageId: String(msg.id),
          waId: msg.from,
          name: names.get(msg.from) ?? null,
          type: String(msg.type || 'unknown'),
          text: extractText(msg).slice(0, 4000),
          timestamp: msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date(),
          // Anúncio "Clique para WhatsApp" manda o referral com a origem.
          referralSource: msg.referral?.source_type ?? null,
        });
      }
    }
  }
  return out;
}

/** Extrai o código do imóvel ("#CASA01") da mensagem pré-preenchida do link. */
function extractPropertyCode(text) {
  const m = PROPERTY_CODE_RE.exec(text || '');
  return m ? m[1].toUpperCase() : null;
}

module.exports = { parseWebhook, extractPropertyCode };
