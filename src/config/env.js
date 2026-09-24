'use strict';

require('dotenv').config();
const { z } = require('zod');

// Toda configuração vem do ambiente e é validada na subida.
// Segredos NUNCA ficam no código — ver .env.example.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url(),
  CORS_ORIGINS: z.string().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Banco: usuário da aplicação (sem SUPERUSER/BYPASSRLS) e usuário de migração (owner).
  DATABASE_URL: z.string().min(1),
  DATABASE_MIGRATION_URL: z.string().min(1),

  // Auth
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),

  // WhatsApp Cloud API
  WA_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/),
  WA_ACCESS_TOKEN: z.string().min(1),
  WA_APP_SECRET: z.string().min(1),
  WA_VERIFY_TOKEN: z.string().min(16),
  WA_OWNER_ALERT_TEMPLATE: z.string().default(''),
  WA_OWNER_ALERT_TEMPLATE_LANG: z.string().default('pt_BR'),
  // Dev local: 'true' = não chama a Meta, só registra a saída (painel/simulador). Ignorado em produção.
  WA_MOCK: z.enum(['true', 'false']).default('false'),
  // Dev local: 'true' = o painel entra sozinho como o admin do seed, sem senha. Ignorado em produção.
  DEV_AUTO_LOGIN: z.enum(['true', 'false']).default('false'),
  SEED_TENANT_SLUG: z.string().regex(/^[a-z0-9-]{3,40}$/).optional(),
  SEED_ADMIN_EMAIL: z.string().email().optional(),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().min(1),

  // Atendimento
  REPLY_DEBOUNCE_MS: z.coerce.number().int().min(0).default(4000),
  HISTORY_MAX_MESSAGES: z.coerce.number().int().min(4).max(100).default(30),
  FOLLOWUP_AFTER_MINUTES: z.coerce.number().int().positive().default(180),
  FOLLOWUP_JOB_INTERVAL_MS: z.coerce.number().int().positive().default(300000),
  PRIVACY_URL: z.string().url(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Não imprime valores, só os nomes das variáveis com problema.
  const campos = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
  throw new Error(`Variáveis de ambiente inválidas ou ausentes: ${campos}`);
}

const env = parsed.data;
env.corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
env.isDev = env.NODE_ENV !== 'production';
env.waMock = env.isDev && env.WA_MOCK === 'true';
env.devAutoLogin = env.isDev && env.DEV_AUTO_LOGIN === 'true';

module.exports = env;
