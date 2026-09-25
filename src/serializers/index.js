'use strict';

// Serializers: a API devolve DTOs, nunca o model cru.

const iso = (d) => (d ? new Date(d).toISOString() : null);

function user(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, emailVerified: Boolean(u.emailVerifiedAt) };
}

function property(p) {
  return {
    id: p.id,
    code: p.code,
    title: p.title,
    description: p.description,
    locationSummary: p.locationSummary,
    dealType: p.dealType,
    priceCents: p.priceCents,
    feesCents: p.feesCents,
    bedrooms: p.bedrooms,
    allowsPets: p.allowsPets,
    maxOccupants: p.maxOccupants,
    acceptedGuarantees: p.acceptedGuarantees,
    availableFrom: p.availableFrom,
    extraInfo: p.extraInfo,
    isActive: p.isActive,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
  };
}

function lead(l) {
  const q = l.qualification || {};
  return {
    id: l.id,
    phone: l.waId,
    name: l.displayName,
    property: l.property ? { id: l.property.id, code: l.property.code, title: l.property.title } : null,
    status: l.status,
    classification: l.classification,
    score: l.score,
    qualification: {
      monthlyIncomeCents: q.monthlyIncomeCents ?? null,
      guarantee: q.guarantee ?? null,
      occupants: q.occupants ?? null,
      hasPets: q.hasPets ?? null,
      moveInDays: q.moveInDays ?? null,
      wantsVisit: q.wantsVisit ?? null,
    },
    disqualifyReasons: l.disqualifyReasons || [],
    visitPreference: l.visitPreference,
    botActive: l.botActive,
    handoffReason: l.handoffReason,
    handoffSummary: l.handoffSummary ?? null,
    handoffAt: iso(l.handoffAt),
    openQuestions: Array.isArray(l.openQuestions) ? l.openQuestions : [],
    lastInboundAt: iso(l.lastInboundAt),
    lastOutboundAt: iso(l.lastOutboundAt),
    source: l.source,
    anonymized: Boolean(l.anonymizedAt),
    createdAt: iso(l.createdAt),
    updatedAt: iso(l.updatedAt),
  };
}

function message(m) {
  return { id: m.id, direction: m.direction, author: m.author, type: m.msgType, text: m.body, createdAt: iso(m.createdAt) };
}

function openQuestion(r) {
  return { question: r.question, leads: Number(r.leads), lastAskedAt: iso(r.lastAskedAt) };
}

function awaitingLead(r) {
  return {
    id: r.id,
    name: r.displayName,
    phone: r.waId,
    propertyCode: r.propertyCode,
    classification: r.classification,
    handoffAt: iso(r.handoffAt),
    waitingMinutes: r.waitingMinutes,
  };
}

/** Conta + usuário logado + primeiros passos. Nunca o token do WhatsApp nem ids internos da Meta. */
function account({ tenant, user: u, onboarding, whatsappSignup }) {
  return {
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, assistantName: tenant.assistantName, whatsappConnected: Boolean(tenant.waPhoneNumberId), retentionMonths: tenant.retentionMonths,
      timezone: tenant.timezone, handoffSlaMinutes: tenant.handoffSlaMinutes, digestEnabled: tenant.digestEnabled, visitSchedule: tenant.visitSchedule },
    user: user(u),
    onboarding,
    whatsappSignup: whatsappSignup || null, // app id e config públicos para o cadastro incorporado da Meta
  };
}

/** Aviso de qualidade: só códigos e números (details), nunca texto de conversa. */
function alert(a) {
  return {
    id: a.id,
    kind: a.kind,
    details: a.details || {},
    createdAt: iso(a.createdAt),
    lead: a.leadId ? { id: a.leadId, name: a.leadName, phone: a.leadPhone } : null,
    property: a.propertyId ? { id: a.propertyId, code: a.propertyCode } : null,
  };
}

function visit(v) {
  return {
    id: v.id,
    startsAt: iso(v.startsAt),
    endsAt: iso(v.endsAt),
    label: v.label,
    status: v.status,
    createdBy: v.createdBy,
    reminderSent: Boolean(v.reminderSentAt),
    lead: { id: v.leadId, name: v.leadAnonymized ? null : v.leadName, phone: v.leadAnonymized ? null : v.leadPhone },
    property: { id: v.propertyId, code: v.propertyCode, title: v.propertyTitle },
  };
}

module.exports = { user, property, lead, message, openQuestion, awaitingLead, account, alert, visit };
