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
  // Token global: usado só por conta que não tem token próprio (instalação de um cliente só).
  WA_ACCESS_TOKEN: z.string().default(''),
  // Chave AES-256 (64 caracteres hex) que cifra o token de cada conta. Obrigatória para gravar/ler token por conta.
  WA_TOKEN_ENC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
  WA_APP_SECRET: z.string().min(1),
  WA_VERIFY_TOKEN: z.string().min(16),
  // Cadastro incorporado da Meta (conectar o WhatsApp pelo painel). Vazios = botão escondido.
  // META_APP_ID: id do app (o mesmo do WA_APP_SECRET). META_ES_CONFIG_ID: configuração do "Login do Facebook para Empresas".
  META_APP_ID: z.string().regex(/^\d{5,30}$/).optional().or(z.literal('')),
  META_ES_CONFIG_ID: z.string().regex(/^\d{5,30}$/).optional().or(z.literal('')),
  WA_OWNER_ALERT_TEMPLATE: z.string().default(''),
  WA_OWNER_ALERT_TEMPLATE_LANG: z.string().default('pt_BR'),
  // Resumo diário ao dono (5 variáveis: quentes aguardando, total aguardando, leads novos ontem, visitas hoje, avisos).
  WA_DAILY_DIGEST_TEMPLATE: z.string().default(''),
  // Lembrete de visita ao lead fora da janela de 24 h (3 variáveis: nome, imóvel, dia e hora).
  WA_VISIT_REMINDER_TEMPLATE: z.string().default(''),
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

  // E-mail transacional: 'log' não envia (dev: caixa de saída local no painel); 'resend' envia pela API do Resend.
  EMAIL_PROVIDER: z.enum(['log', 'resend']).default('log'),
  EMAIL_FROM: z.string().min(3).default('Imobi <nao-responda@localhost>'),
  RESEND_API_KEY: z.string().default(''),

  // Modo piloto: 'false' desliga a cobrança (sem teste grátis que vence, sem limites, sem planos no painel)
  // e o cadastro público (contas criadas só pelo comando `npm run conta -- criar`).
  BILLING_ENABLED: z.enum(['true', 'false']).default('true'),
  SIGNUP_ENABLED: z.enum(['true', 'false']).default('true'),

  // Cobrança: 'mock' simula no ambiente local; 'asaas' usa a API do Asaas.
  BILLING_PROVIDER: z.enum(['mock', 'asaas']).default('mock'),
  ASAAS_API_KEY: z.string().default(''),
  // Testes: https://sandbox.asaas.com/api/v3 · Produção: https://api.asaas.com/v3
  ASAAS_BASE_URL: z.string().url().default('https://sandbox.asaas.com/api/v3'),
  // Texto que você define no painel do Asaas (Integrações > Webhooks) e ele devolve no header asaas-access-token.
  ASAAS_WEBHOOK_TOKEN: z.string().default(''),

  // Fila de jobs (aim_job)
  JOB_POLL_MS: z.coerce.number().int().min(20).default(1000),
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  JOB_STALE_SEC: z.coerce.number().int().min(30).default(300),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Não imprime valores, só os nomes das variáveis com problema.
  const campos = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
  throw new Error(`Variáveis de ambiente inválidas ou ausentes: ${campos}`);
}

const env = parsed.data;
if (env.BILLING_PROVIDER === 'asaas' && (!env.ASAAS_API_KEY || env.ASAAS_WEBHOOK_TOKEN.length < 16)) {
  throw new Error('Variáveis de ambiente inválidas ou ausentes: ASAAS_API_KEY e ASAAS_WEBHOOK_TOKEN (mín. 16) são obrigatórias com BILLING_PROVIDER=asaas');
}
if (env.EMAIL_PROVIDER === 'resend' && !env.RESEND_API_KEY) {
  throw new Error('Variáveis de ambiente inválidas ou ausentes: RESEND_API_KEY (obrigatória com EMAIL_PROVIDER=resend)');
}
env.corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
env.isDev = env.NODE_ENV !== 'production';
env.waMock = env.isDev && env.WA_MOCK === 'true';
env.devAutoLogin = env.isDev && env.DEV_AUTO_LOGIN === 'true';
env.embeddedSignup = Boolean(env.META_APP_ID && env.META_ES_CONFIG_ID);
env.billingEnabled = env.BILLING_ENABLED === 'true';
env.signupEnabled = env.SIGNUP_ENABLED === 'true';

module.exports = env;
