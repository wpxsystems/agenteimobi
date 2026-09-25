'use strict';

/**
 * Cliente mínimo da API v3 do Asaas (https://docs.asaas.com).
 * Só o que o checkout e os avisos precisam: cliente, assinatura mensal, cobranças da assinatura.
 * Escrito pela documentação da API; conferir no ambiente de testes (sandbox) antes de produção.
 *
 * Nunca loga CPF/CNPJ, e-mail nem o corpo das respostas.
 */

const env = require('../../config/env');
const logger = require('../../config/logger');
const AppError = require('../../errors/AppError');

async function call(method, path, body) {
  if (!env.ASAAS_API_KEY) throw new AppError('BILLING_NOT_CONFIGURED', 'Cobrança não configurada', 503);
  const res = await fetch(`${env.ASAAS_BASE_URL.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      access_token: env.ASAAS_API_KEY,
      'Content-Type': 'application/json',
      'User-Agent': 'agente-imobi',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const codes = Array.isArray(data.errors) ? data.errors.map((e) => e.code).join(',') : undefined;
    logger.error({ status: res.status, path: path.replace(/\/[A-Za-z0-9_-]{8,}/g, '/:id'), asaasErrors: codes }, 'Falha na API do Asaas');
    throw new AppError('BILLING_PROVIDER_ERROR', 'Não foi possível falar com o sistema de cobrança. Tente de novo em instantes.', 502);
  }
  return data;
}

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // AAAA-MM-DD

/**
 * Cria (ou reaproveita) o cliente e a assinatura mensal, e devolve o link da primeira cobrança.
 * Assinatura já existente: muda valor e descrição e devolve a próxima cobrança em aberto.
 */
async function createCheckout({ tenantId, customerId, subscriptionId, name, email, document, plan }) {
  let customer = customerId;
  if (!customer) {
    const c = await call('POST', '/customers', { name, email, cpfCnpj: document, externalReference: tenantId, notificationDisabled: false });
    customer = c.id;
  }
  const value = plan.priceCents / 100;
  const description = `Imobi - plano ${plan.name}`;
  let subscription = subscriptionId;
  if (subscription) {
    await call('POST', `/subscriptions/${encodeURIComponent(subscription)}`, { value, description, updatePendingPayments: true });
  } else {
    const s = await call('POST', '/subscriptions', {
      customer,
      billingType: 'UNDEFINED', // a pessoa escolhe PIX, boleto ou cartão na página do Asaas
      value,
      nextDueDate: today(),
      cycle: 'MONTHLY',
      description,
      externalReference: tenantId,
    });
    subscription = s.id;
  }
  const payments = await call('GET', `/subscriptions/${encodeURIComponent(subscription)}/payments?status=PENDING`);
  const open = Array.isArray(payments.data) ? payments.data.find((p) => p.invoiceUrl) : null;
  return { customerId: customer, subscriptionId: subscription, checkoutUrl: open ? open.invoiceUrl : null };
}

/**
 * Lê do Asaas a verdade sobre um aviso (não confia no corpo recebido).
 * @returns {{ tenantId, subscriptionId, subscriptionStatus, nextDueDate, value } | null}
 */
async function fetchSubscriptionState(subscriptionId) {
  if (!subscriptionId) return null;
  const s = await call('GET', `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  return {
    tenantId: s.externalReference || null,
    subscriptionId: s.id,
    subscriptionStatus: s.status, // ACTIVE | INACTIVE | EXPIRED
    nextDueDate: s.nextDueDate || null,
    value: typeof s.value === 'number' ? s.value : null,
    deleted: Boolean(s.deleted),
  };
}

async function fetchPayment(paymentId) {
  const p = await call('GET', `/payments/${encodeURIComponent(paymentId)}`);
  return { id: p.id, status: p.status, subscriptionId: p.subscription || null, dueDate: p.dueDate || null };
}

async function cancelSubscription(subscriptionId) {
  await call('DELETE', `/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

module.exports = { createCheckout, fetchSubscriptionState, fetchPayment, cancelSubscription };
