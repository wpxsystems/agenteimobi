'use strict';

// Schemas Zod de entrada. Todos .strict(): campo desconhecido é rejeitado (nada de .passthrough()).
const { z } = require('zod');
const { GUARANTEES } = require('../services/scoring');

const uuid = z.string().uuid();

const login = z
  .object({
    tenant: z.string().regex(/^[a-z0-9-]{3,40}$/),
    email: z.string().email().max(200),
    password: z.string().min(1).max(200),
  })
  .strict();

const refresh = z.object({ refreshToken: z.string().min(10).max(2000) }).strict();

const propertyBase = {
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,12}$/, 'Use 3 a 12 letras/números'),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(3000).default(''),
  locationSummary: z.string().trim().max(160).default(''),
  dealType: z.enum(['aluguel', 'venda']).default('aluguel'),
  priceCents: z.number().int().positive().max(100_000_000_000),
  feesCents: z.number().int().min(0).max(10_000_000_000).default(0),
  bedrooms: z.number().int().min(0).max(50).nullable().default(null),
  allowsPets: z.boolean().nullable().default(null),
  maxOccupants: z.number().int().min(1).max(50).nullable().default(null),
  acceptedGuarantees: z.array(z.enum(GUARANTEES)).max(GUARANTEES.length).default([]),
  availableFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  extraInfo: z.string().trim().max(3000).default(''),
  isActive: z.boolean().default(true),
};

const propertyCreate = z.object(propertyBase).strict();

// No update nada tem default: só altera o que veio.
const propertyUpdate = z
  .object(Object.fromEntries(Object.entries(propertyBase).map(([k, v]) => [k, v.removeDefault ? v.removeDefault().optional() : v.optional()])))
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'Informe ao menos um campo');

const idParam = z.object({ id: uuid }).strict();

const linkQuery = z.object({ src: z.string().regex(/^[a-z0-9_-]{1,30}$/).optional() }).strict();

const leadList = z
  .object({
    classification: z.enum(['indefinido', 'quente', 'morno', 'frio']).optional(),
    status: z.enum(['novo', 'em_atendimento', 'transferido', 'visita_agendada', 'descartado', 'opt_out']).optional(),
    propertyId: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const leadUpdate = z
  .object({
    status: z.enum(['em_atendimento', 'transferido', 'visita_agendada', 'descartado']).optional(),
    botActive: z.boolean().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'Informe ao menos um campo');

const humanMessage = z.object({ text: z.string().trim().min(1).max(4000) }).strict();

const funnelQuery = z
  .object({
    propertyId: uuid.optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

const leadExport = funnelQuery.extend({ format: z.enum(['csv', 'xlsx']).default('csv') }).strict();

const redirectParams = z
  .object({
    slug: z.string().regex(/^[a-z0-9-]{3,40}$/),
    code: z.string().regex(/^[A-Za-z0-9]{3,12}$/).transform((s) => s.toUpperCase()),
  })
  .strict();

// Simulador (dev): mensagem como se viesse do lead pelo WhatsApp.
const devInbound = z
  .object({
    phone: z.string().regex(/^[0-9]{8,15}$/, 'Só dígitos, com DDI'),
    name: z.string().trim().max(120).optional(),
    text: z.string().trim().min(1).max(4000),
  })
  .strict();

// ---- Conta: cadastro, links de uso único e primeiros passos ----
const password = z.string().min(10, 'Use ao menos 10 caracteres').max(200);
const oneTimeToken = z.string().min(40).max(200);

const signup = z
  .object({
    accountName: z.string().trim().min(2).max(80),
    // Começa e termina com letra ou número; hífen só no meio.
    slug: z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/, 'Use 3 a 40 letras minúsculas, números ou hífen'),
    name: z.string().trim().min(2).max(80),
    email: z.string().trim().email().max(200),
    password,
    acceptTerms: z.literal(true, { errorMap: () => ({ message: 'É preciso aceitar os termos e a política de privacidade' }) }),
  })
  .strict();

const verifyEmail = z.object({ token: oneTimeToken }).strict();
const forgotPassword = z
  .object({ tenant: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{3,40}$/), email: z.string().trim().email().max(200) })
  .strict();
const resetPassword = z.object({ token: oneTimeToken, password }).strict();
const onboardingStep = z.object({ step: z.enum(['link', 'teste']) }).strict();

// ---- Plano e cobrança ----
const checkout = z
  .object({
    plan: z.string().regex(/^[a-z_]{3,30}$/),
    // CPF ou CNPJ, com ou sem pontuação. Validado no service; não é gravado.
    document: z.string().trim().max(20),
  })
  .strict();
const billingSimulate = z.object({ kind: z.enum(['paid', 'overdue', 'canceled']) }).strict();

// ---- Conexão do WhatsApp (cadastro incorporado da Meta) ----
const whatsappConnect = z
  .object({
    code: z.string().min(10).max(2000),
    wabaId: z.string().regex(/^[0-9]{5,30}$/),
    phoneNumberId: z.string().regex(/^[0-9]{5,30}$/),
  })
  .strict();

// ---- Rotina do dono: avisos, resumo e visitas ----
const routine = z
  .object({
    timezone: z.string().regex(/^America\/[A-Za-z_]+$/).optional(),
    handoffSlaMinutes: z.number().int().min(15).max(1440).optional(),
    digestEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'Informe ao menos um campo');
const visitSchedule = z
  .object({
    slotMinutes: z.number().int(),
    days: z.record(z.string().regex(/^[0-6]$/), z.array(z.string().max(20)).max(4)),
  })
  .strict();
const visitCreate = z.object({ leadId: uuid, startsAt: z.string().datetime({ offset: true }), propertyId: uuid.optional() }).strict();
const visitUpdate = z
  .object({
    status: z.enum(['cancelada', 'realizada', 'nao_compareceu']).optional(),
    startsAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((o) => Boolean(o.status) !== Boolean(o.startsAt), 'Informe a nova situação OU o novo horário');
const visitList = z
  .object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() })
  .strict();

// ---- Privacidade (LGPD) ----
const retention = z.object({ retentionMonths: z.number().int().min(3).max(24) }).strict();
const deleteAccount = z
  .object({ password: z.string().min(1).max(200), slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{3,40}$/) })
  .strict();

module.exports = {
  routine,
  visitSchedule,
  visitCreate,
  visitUpdate,
  visitList,
  whatsappConnect,
  retention,
  deleteAccount,
  checkout,
  billingSimulate,
  signup,
  verifyEmail,
  forgotPassword,
  resetPassword,
  onboardingStep,
  devInbound,
  login,
  refresh,
  propertyCreate,
  propertyUpdate,
  idParam,
  linkQuery,
  leadList,
  leadUpdate,
  humanMessage,
  funnelQuery,
  leadExport,
  redirectParams,
};
