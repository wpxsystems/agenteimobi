'use strict';

/**
 * Planos, assinatura e cobrança (itens 1.3 e 1.4 do plano). Ver docs/logica/planos-cobranca.md.
 *
 *   overview            : plano, situação, uso do mês e planos à venda (tela "Plano e uso")
 *   startCheckout       : cria/atualiza a assinatura no provedor e devolve o link de pagamento
 *   handleAsaasWebhook  : aviso do Asaas -> confere na API do Asaas -> atualiza a assinatura
 *   simulateEvent       : só fora de produção, com BILLING_PROVIDER=mock
 *   conversationGate    : a IA pode abrir conversa nova para este lead?
 *   assertCanActivateProperty : limite de imóveis ativos
 *
 * CPF/CNPJ só passa por aqui a caminho do provedor: não é gravado nem logado.
 */

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const env = require('../config/env');
const logger = require('../config/logger');
const { PLANS, PURCHASABLE, TRIAL_DAYS, GRACE_DAYS } = require('../config/plans');
const inTx = require('../db/inTx');
const AppError = require('../errors/AppError');
const { sequelize, Tenant, User } = require('../models');
const usage = require('./usage.service');
const { entitlement, canStartConversation, canActivateProperty, usagePercent } = require('./billing/entitlement');
const { normalizeDocument } = require('./billing/document');
const asaas = require('./billing/asaas');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SUB_COLUMNS = `plan, status, pending_plan AS "pendingPlan", trial_ends_at AS "trialEndsAt",
  current_period_end AS "currentPeriodEnd", grace_until AS "graceUntil", provider,
  provider_customer_id AS "providerCustomerId", provider_subscription_id AS "providerSubscriptionId"`;

/** Linha de aim_subscription da conta, ou null. Dentro de inTx da conta. */
async function loadSubscription(t, { lock = false } = {}) {
  const [row] = await sequelize.query(`SELECT ${SUB_COLUMNS} FROM aim_subscription ${lock ? 'FOR UPDATE' : ''}`, {
    type: QueryTypes.SELECT,
    transaction: t,
  });
  return row || null;
}

/**
 * Direito de uso da conta. Com a cobrança desligada (modo piloto, BILLING_ENABLED=false) toda conta
 * atende sem limite e sem vencimento, sem mexer no que está gravado: ao religar, vale o plano de cada uma.
 */
function accountEntitlement(sub) {
  if (!env.billingEnabled) return { ...entitlement(null), planName: 'Piloto' };
  return entitlement(sub);
}

/** Cria o teste grátis da conta nova. Dentro da transação do cadastro. */
async function createTrial(tenantId, t) {
  await sequelize.query(
    `INSERT INTO aim_subscription (tenant_id, plan, status, trial_ends_at)
     VALUES (:tenantId, 'teste', 'teste', now() + make_interval(days => :days))`,
    { replacements: { tenantId, days: TRIAL_DAYS }, transaction: t }
  );
}

const iso = (d) => (d ? new Date(d).toISOString() : null);

function publicPlan(key) {
  const p = PLANS[key];
  return { key, name: p.name, priceCents: p.priceCents, description: p.description || '', limits: p.limits };
}

async function overview(tenantId) {
  return inTx(tenantId, async (t) => {
    const sub = await loadSubscription(t);
    const ent = accountEntitlement(sub);
    const used = await usage.current(tenantId, t);
    const [{ n: activeProperties }] = await sequelize.query('SELECT count(*)::int AS n FROM aim_property WHERE is_active', {
      type: QueryTypes.SELECT,
      transaction: t,
    });
    return {
      subscription: {
        plan: ent.plan,
        planName: ent.planName,
        status: ent.status,
        active: ent.active,
        reason: ent.reason,
        warning: ent.warning,
        daysLeft: ent.daysLeft,
        trialEndsAt: iso(ent.trialEndsAt),
        currentPeriodEnd: iso(ent.currentPeriodEnd),
        graceUntil: iso(ent.graceUntil),
        pendingPlan: sub ? sub.pendingPlan : null,
      },
      limits: ent.limits,
      usage: { ...used, activeProperties },
      percent: {
        conversations: usagePercent(used.conversations, ent.limits.conversations),
        properties: usagePercent(activeProperties, ent.limits.properties),
      },
      plans: env.billingEnabled ? PURCHASABLE.map(publicPlan) : [],
      billing: { enabled: env.billingEnabled, provider: env.BILLING_PROVIDER, simulated: env.BILLING_PROVIDER === 'mock' },
    };
  });
}

/**
 * Início do pagamento de um plano. Só admin (a rota exige).
 * @returns {{ checkoutUrl: string|null, simulated: boolean }}
 */
async function startCheckout(tenantId, userId, { plan, document }) {
  if (!env.billingEnabled) throw new AppError('BILLING_DISABLED', 'A contratação de planos ainda não está aberta', 503);
  if (!PURCHASABLE.includes(plan)) throw AppError.validation([{ path: 'plan', message: 'Plano indisponível' }]);
  const doc = normalizeDocument(document);
  if (!doc) throw AppError.validation([{ path: 'document', message: 'CPF ou CNPJ inválido' }]);

  const ctx = await inTx(tenantId, async (t) => {
    const tenant = await Tenant.findByPk(tenantId, { transaction: t });
    const user = await User.findByPk(userId, { transaction: t });
    const sub = await loadSubscription(t);
    return { tenant, user, sub };
  });
  if (!ctx.user || !ctx.user.emailVerifiedAt) {
    throw new AppError('EMAIL_NOT_VERIFIED', 'Confirme seu e-mail antes de contratar um plano', 409);
  }

  let result;
  if (env.BILLING_PROVIDER === 'mock') {
    if (!env.isDev) throw new AppError('BILLING_NOT_CONFIGURED', 'Cobrança não configurada', 503);
    result = { customerId: null, subscriptionId: `mock-${tenantId.slice(0, 8)}`, checkoutUrl: null };
  } else {
    // Chamada de rede fora de transação.
    result = await asaas.createCheckout({
      tenantId,
      customerId: ctx.sub?.provider === 'asaas' ? ctx.sub.providerCustomerId : null,
      subscriptionId: ctx.sub?.provider === 'asaas' ? ctx.sub.providerSubscriptionId : null,
      name: ctx.tenant.name,
      email: ctx.user.email,
      document: doc,
      plan: PLANS[plan],
    });
  }

  await inTx(tenantId, (t) =>
    sequelize.query(
      // Conta sem linha (seed/antiga) é 'interno': continua assim até o pagamento confirmar.
      `INSERT INTO aim_subscription (tenant_id, plan, status, pending_plan, provider, provider_customer_id, provider_subscription_id)
       VALUES (:tenantId, 'interno', 'ativa', :plan, :provider, :customerId, :subscriptionId)
       ON CONFLICT (tenant_id) DO UPDATE SET
         pending_plan = EXCLUDED.pending_plan,
         provider = EXCLUDED.provider,
         provider_customer_id = COALESCE(EXCLUDED.provider_customer_id, aim_subscription.provider_customer_id),
         provider_subscription_id = EXCLUDED.provider_subscription_id,
         updated_at = now()`,
      {
        replacements: {
          tenantId,
          plan,
          provider: env.BILLING_PROVIDER,
          customerId: result.customerId,
          subscriptionId: result.subscriptionId,
        },
        transaction: t,
      }
    )
  );
  logger.info({ tenantId, plan, provider: env.BILLING_PROVIDER }, 'Checkout iniciado');
  return { checkoutUrl: result.checkoutUrl, simulated: env.BILLING_PROVIDER === 'mock' };
}

/**
 * Aplica um evento de cobrança já conferido. Idempotente por (provider, eventId).
 * kind: 'paid' | 'overdue' | 'canceled'
 * @returns {'applied'|'duplicate'|'ignored'}
 */
async function applyEvent({ tenantId, provider, eventId, eventType, kind, subscriptionId, nextDueDate }) {
  if (!UUID_RE.test(String(tenantId || ''))) return 'ignored';
  return inTx(tenantId, async (t) => {
    const inserted = await sequelize.query(
      `INSERT INTO aim_billing_event (provider, event_id, event_type) VALUES (:provider, :eventId, :eventType)
       ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
      { replacements: { provider, eventId: String(eventId).slice(0, 200), eventType }, type: QueryTypes.SELECT, transaction: t }
    );
    if (inserted.length === 0) return 'duplicate';

    const sub = await loadSubscription(t, { lock: true });
    // O aviso tem que ser da assinatura que esta conta criou.
    if (!sub || sub.provider !== provider || sub.providerSubscriptionId !== subscriptionId) {
      logger.warn({ tenantId, provider, eventType }, 'Aviso de cobrança de assinatura desconhecida: ignorado');
      return 'ignored';
    }

    if (kind === 'paid') {
      // Pago: vira o plano escolhido e vale até o próximo vencimento (fim do dia em São Paulo).
      await sequelize.query(
        `UPDATE aim_subscription
            SET status = 'ativa',
                plan = COALESCE(pending_plan, plan),
                pending_plan = NULL,
                grace_until = NULL,
                current_period_end = COALESCE(
                  (CAST(:nextDueDate AS date) + interval '1 day' - interval '1 millisecond') AT TIME ZONE 'America/Sao_Paulo',
                  now() + interval '1 month'),
                updated_at = now()`,
        { replacements: { nextDueDate: nextDueDate || null }, transaction: t }
      );
    } else if (kind === 'overdue') {
      // Atrasou: continua atendendo por GRACE_DAYS a partir do primeiro aviso de atraso.
      await sequelize.query(
        `UPDATE aim_subscription
            SET status = 'inadimplente',
                grace_until = CASE WHEN status = 'inadimplente' AND grace_until IS NOT NULL THEN grace_until
                                   ELSE now() + make_interval(days => :grace) END,
                updated_at = now()`,
        { replacements: { grace: GRACE_DAYS }, transaction: t }
      );
    } else if (kind === 'canceled') {
      // Cancelou: o que já foi pago vale até current_period_end.
      await sequelize.query(`UPDATE aim_subscription SET status = 'cancelada', pending_plan = NULL, updated_at = now()`, {
        transaction: t,
      });
    } else {
      return 'ignored';
    }
    logger.info({ tenantId, provider, eventType, kind }, 'Assinatura atualizada');
    return 'applied';
  });
}

const PAID_STATUSES = new Set(['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH']);
const RELEVANT = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_OVERDUE', 'SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED']);

function tokenMatches(received, expected) {
  const a = Buffer.from(String(received || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  return b.length >= 16 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Aviso do Asaas. Não confia no corpo: confere pagamento e assinatura na API do Asaas.
 * @returns {Promise<{ status: number, result: string }>}
 */
async function handleAsaasWebhook(headerToken, body) {
  if (!env.billingEnabled || env.BILLING_PROVIDER !== 'asaas') return { status: 404, result: 'disabled' };
  if (!tokenMatches(headerToken, env.ASAAS_WEBHOOK_TOKEN)) return { status: 401, result: 'unauthorized' };
  const eventType = typeof body?.event === 'string' && /^[A-Z_]{1,60}$/.test(body.event) ? body.event : null;
  if (!eventType || !RELEVANT.has(eventType)) return { status: 200, result: 'ignored' };

  let subscriptionId = null;
  let kind = null;
  let paymentStatus = null;
  if (eventType.startsWith('PAYMENT_')) {
    const paymentId = body.payment?.id;
    if (typeof paymentId !== 'string') return { status: 200, result: 'ignored' };
    const payment = await asaas.fetchPayment(paymentId);
    subscriptionId = payment.subscriptionId;
    paymentStatus = payment.status;
    if (eventType === 'PAYMENT_OVERDUE') kind = payment.status === 'OVERDUE' ? 'overdue' : null;
    else kind = PAID_STATUSES.has(payment.status) ? 'paid' : null;
  } else {
    subscriptionId = body.subscription?.id;
  }
  if (!subscriptionId || typeof subscriptionId !== 'string') return { status: 200, result: 'ignored' };

  const state = await asaas.fetchSubscriptionState(subscriptionId);
  if (eventType.startsWith('SUBSCRIPTION_')) kind = state.deleted || state.subscriptionStatus !== 'ACTIVE' ? 'canceled' : null;
  if (!kind) return { status: 200, result: 'ignored' };

  const eventId = typeof body.id === 'string' ? body.id : `${eventType}:${body.payment?.id || subscriptionId}:${paymentStatus || ''}`;
  const result = await applyEvent({
    tenantId: state.tenantId,
    provider: 'asaas',
    eventId,
    eventType,
    kind,
    subscriptionId,
    nextDueDate: state.nextDueDate,
  });
  return { status: 200, result };
}

/** Só fora de produção, com BILLING_PROVIDER=mock: simula o aviso do provedor para a conta logada. */
async function simulateEvent(tenantId, kind) {
  if (!env.isDev || !env.billingEnabled || env.BILLING_PROVIDER !== 'mock') throw AppError.notFound('Rota');
  const sub = await inTx(tenantId, (t) => loadSubscription(t));
  if (!sub || sub.provider !== 'mock') throw new AppError('NO_CHECKOUT', 'Escolha um plano antes de simular o pagamento', 409);
  const nextDueDate = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  return applyEvent({
    tenantId,
    provider: 'mock',
    eventId: `mock-${crypto.randomUUID()}`,
    eventType: { paid: 'PAYMENT_CONFIRMED', overdue: 'PAYMENT_OVERDUE', canceled: 'SUBSCRIPTION_DELETED' }[kind],
    kind,
    subscriptionId: sub.providerSubscriptionId,
    nextDueDate,
  });
}

/**
 * A IA pode responder este lead? Conversa já contada no mês segue sempre (nunca é cortada no meio).
 * Conversa nova precisa de assinatura ativa e de espaço no limite do plano. Dentro de inTx da conta.
 * @returns {{ ok: boolean, reason: string|null }}
 */
async function conversationGate(leadId, t) {
  const [row] = await sequelize.query(
    `SELECT (l.usage_month IS NOT DISTINCT FROM ${usage.MONTH_SQL}) AS counted,
            COALESCE(u.conversations, 0) AS used
       FROM aim_lead l
       LEFT JOIN aim_usage_month u ON u.tenant_id = l.tenant_id AND u.month = ${usage.MONTH_SQL}
      WHERE l.id = :leadId`,
    { replacements: { leadId }, type: QueryTypes.SELECT, transaction: t }
  );
  if (!row) return { ok: false, reason: 'lead_inexistente' };
  if (row.counted) return { ok: true, reason: null };
  return canStartConversation(accountEntitlement(await loadSubscription(t)), row.used);
}

/** Lança 403 PLAN_LIMIT se ativar mais um imóvel passar do limite do plano. Dentro de inTx da conta. */
async function assertCanActivateProperty(t) {
  const ent = accountEntitlement(await loadSubscription(t));
  const [{ n }] = await sequelize.query('SELECT count(*)::int AS n FROM aim_property WHERE is_active', { type: QueryTypes.SELECT, transaction: t });
  if (!canActivateProperty(ent, n)) {
    throw new AppError('PLAN_LIMIT', `Seu plano permite ${ent.limits.properties} imóveis ativos. Desative um ou mude de plano.`, 403);
  }
}

module.exports = {
  overview,
  startCheckout,
  handleAsaasWebhook,
  simulateEvent,
  applyEvent,
  conversationGate,
  assertCanActivateProperty,
  createTrial,
  tokenMatches,
  accountEntitlement,
};
