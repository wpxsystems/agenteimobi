'use strict';

/**
 * Envio de e-mail transacional (confirmação de e-mail, redefinição de senha).
 *
 *   EMAIL_PROVIDER=log    : não envia. Fora de produção guarda as últimas mensagens em memória
 *                           (caixa de saída do painel local). Em produção só registra um aviso.
 *   EMAIL_PROVIDER=resend : envia pela API HTTP do Resend (RESEND_API_KEY, EMAIL_FROM).
 *
 * Nunca loga o corpo nem o destinatário completo: o link carrega um token de uso único.
 */

const env = require('../config/env');
const logger = require('../config/logger');
const AppError = require('../errors/AppError');

const OUTBOX_MAX = 20;
const outbox = [];

function maskEmail(email) {
  const [user, domain] = String(email).split('@');
  if (!domain) return '***';
  return `${user.slice(0, 1)}***@${domain}`;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Monta texto e HTML simples a partir de parágrafos e um botão. */
function compose({ greeting, paragraphs, action, footer }) {
  const text = [greeting, '', ...paragraphs, '', `${action.label}: ${action.url}`, '', footer].join('\n');
  const html = `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2a24">
<p>${escapeHtml(greeting)}</p>
${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')}
<p><a href="${escapeHtml(action.url)}" style="display:inline-block;background:#1f4d3a;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none">${escapeHtml(action.label)}</a></p>
<p style="font-size:13px;color:#5b6660">Se o botão não abrir, copie este endereço no navegador:<br>${escapeHtml(action.url)}</p>
<p style="font-size:13px;color:#5b6660">${escapeHtml(footer)}</p>
</body></html>`;
  return { text, html };
}

async function sendViaResend({ to, subject, text, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text, html }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    logger.error({ status: res.status, to: maskEmail(to) }, 'Falha ao enviar e-mail');
    throw new AppError('EMAIL_SEND_FAILED', 'Falha ao enviar e-mail', 502);
  }
}

/**
 * @param {{ to: string, subject: string, text: string, html: string, link?: string }} msg
 */
async function send(msg) {
  if (env.EMAIL_PROVIDER === 'resend') {
    await sendViaResend(msg);
    logger.info({ to: maskEmail(msg.to), subject: msg.subject }, 'E-mail enviado');
    return;
  }
  if (env.isDev) {
    outbox.unshift({ to: msg.to, subject: msg.subject, text: msg.text, link: msg.link || null, sentAt: new Date().toISOString() });
    outbox.length = Math.min(outbox.length, OUTBOX_MAX);
    logger.info({ to: maskEmail(msg.to), subject: msg.subject }, 'E-mail guardado na caixa de saída local (EMAIL_PROVIDER=log)');
    return;
  }
  logger.warn({ subject: msg.subject }, 'E-mail NÃO enviado: configure EMAIL_PROVIDER=resend em produção');
}

function sendEmailVerification({ to, name, url }) {
  const { text, html } = compose({
    greeting: `Olá, ${name}!`,
    paragraphs: ['Sua conta no Imobi foi criada.', 'Confirme seu e-mail para conectar o WhatsApp e começar a atender. O link vale por 48 horas.'],
    action: { label: 'Confirmar e-mail', url },
    footer: 'Se você não criou esta conta, ignore este e-mail.',
  });
  return send({ to, subject: 'Confirme seu e-mail no Imobi', text, html, link: url });
}

function sendPasswordReset({ to, name, url }) {
  const { text, html } = compose({
    greeting: `Olá, ${name}!`,
    paragraphs: ['Recebemos um pedido para redefinir a senha da sua conta no Imobi.', 'O link vale por 1 hora e só pode ser usado uma vez.'],
    action: { label: 'Criar nova senha', url },
    footer: 'Se você não pediu, ignore este e-mail: sua senha continua a mesma.',
  });
  return send({ to, subject: 'Redefinir sua senha no Imobi', text, html, link: url });
}

/** Caixa de saída local (só fora de produção, com EMAIL_PROVIDER=log). */
function devOutbox() {
  return env.isDev && env.EMAIL_PROVIDER === 'log' ? outbox.slice() : [];
}

module.exports = { sendEmailVerification, sendPasswordReset, devOutbox, maskEmail, compose };
