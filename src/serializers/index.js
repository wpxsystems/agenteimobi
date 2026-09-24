'use strict';

// Serializers: a API devolve DTOs, nunca o model cru.

const iso = (d) => (d ? new Date(d).toISOString() : null);

function user(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role };
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

module.exports = { user, property, lead, message, openQuestion, awaitingLead };
