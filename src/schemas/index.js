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

const redirectParams = z
  .object({
    slug: z.string().regex(/^[a-z0-9-]{3,40}$/),
    code: z.string().regex(/^[A-Za-z0-9]{3,12}$/).transform((s) => s.toUpperCase()),
  })
  .strict();

module.exports = {
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
  redirectParams,
};
