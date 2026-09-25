'use strict';

/**
 * Direito de uso da conta, calculado a partir da assinatura. Funções puras (sem banco).
 *
 * Situação   | Atende?                                   | Motivo quando não atende
 * -----------|-------------------------------------------|--------------------------
 * sem linha  | sim, plano interno (sem limite)           | -
 * teste      | até trial_ends_at                         | teste_expirado
 * ativa      | sim                                       | -
 * inadimplente | até grace_until (e avisa)               | pagamento_atrasado
 * cancelada  | até current_period_end (já foi pago)      | assinatura_cancelada
 */

const { PLANS } = require('../../config/plans');

const DAY_MS = 24 * 60 * 60 * 1000;
const toDate = (v) => (v ? new Date(v) : null);

function daysUntil(date, now) {
  if (!date) return null;
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / DAY_MS));
}

/**
 * @param sub linha de aim_subscription (camelCase) ou null
 * @returns {{ plan, planName, status, active, reason, warning, limits, trialEndsAt, currentPeriodEnd, graceUntil, daysLeft }}
 */
function entitlement(sub, now = new Date()) {
  if (!sub) {
    return { plan: 'interno', planName: PLANS.interno.name, status: 'ativa', active: true, reason: null, warning: null, limits: PLANS.interno.limits, trialEndsAt: null, currentPeriodEnd: null, graceUntil: null, daysLeft: null };
  }
  const plan = PLANS[sub.plan];
  const trialEndsAt = toDate(sub.trialEndsAt);
  const currentPeriodEnd = toDate(sub.currentPeriodEnd);
  const graceUntil = toDate(sub.graceUntil);
  const base = {
    plan: sub.plan,
    planName: plan ? plan.name : sub.plan,
    status: sub.status,
    limits: plan ? plan.limits : { conversations: 0, properties: 0, users: 0, templates: 0 },
    trialEndsAt,
    currentPeriodEnd,
    graceUntil,
    daysLeft: null,
    warning: null,
  };
  if (!plan) return { ...base, active: false, reason: 'plano_desconhecido' };

  switch (sub.status) {
    case 'teste': {
      const active = Boolean(trialEndsAt) && now <= trialEndsAt;
      const daysLeft = daysUntil(trialEndsAt, now);
      return { ...base, active, reason: active ? null : 'teste_expirado', daysLeft, warning: active && daysLeft <= 3 ? 'teste_acabando' : null };
    }
    case 'ativa':
      return { ...base, active: true, reason: null };
    case 'inadimplente': {
      const active = Boolean(graceUntil) && now <= graceUntil;
      return { ...base, active, reason: active ? null : 'pagamento_atrasado', daysLeft: daysUntil(graceUntil, now), warning: 'pagamento_atrasado' };
    }
    case 'cancelada': {
      const active = Boolean(currentPeriodEnd) && now <= currentPeriodEnd;
      return { ...base, active, reason: active ? null : 'assinatura_cancelada', daysLeft: daysUntil(currentPeriodEnd, now), warning: active ? 'assinatura_cancelada' : null };
    }
    default:
      return { ...base, active: false, reason: 'situacao_desconhecida' };
  }
}

/**
 * A IA pode abrir uma conversa NOVA no mês? (conversa já contada no mês nunca é cortada)
 * @returns {{ ok: boolean, reason: string|null }}
 */
function canStartConversation(ent, usedConversations) {
  if (!ent.active) return { ok: false, reason: ent.reason };
  const limit = ent.limits.conversations;
  if (limit !== null && usedConversations >= limit) return { ok: false, reason: 'limite_de_conversas' };
  return { ok: true, reason: null };
}

/** Pode ativar mais um imóvel? `activeCount` = ativos hoje, sem contar o que vai ser ativado. */
function canActivateProperty(ent, activeCount) {
  const limit = ent.limits.properties;
  return limit === null || activeCount < limit;
}

/** Percentual de uso (0 a 100, arredondado para baixo) ou null quando não há limite. */
function usagePercent(used, limit) {
  if (limit === null || limit === undefined) return null;
  if (limit <= 0) return 100;
  return Math.min(100, Math.floor((used / limit) * 100));
}

module.exports = { entitlement, canStartConversation, canActivateProperty, usagePercent };
