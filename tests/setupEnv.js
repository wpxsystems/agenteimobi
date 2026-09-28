'use strict';

// Carrega .env (se existir) e completa com valores FALSOS só para os testes unitários subirem.
require('dotenv').config();

const defaults = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  PUBLIC_BASE_URL: 'https://agente.test',
  PRIVACY_URL: 'https://agente.test/privacidade',
  DATABASE_URL: 'postgres://aim_app:x@localhost:5432/agente_imobi',
  DATABASE_MIGRATION_URL: 'postgres://aim_owner:x@localhost:5432/agente_imobi',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  WA_GRAPH_VERSION: 'v23.0',
  WA_ACCESS_TOKEN: 'test-token',
  WA_APP_SECRET: 'test-app-secret',
  WA_VERIFY_TOKEN: 'verify-token-1234567890',
  ANTHROPIC_API_KEY: 'test-key',
  ANTHROPIC_MODEL: 'claude-test',
  REPLY_DEBOUNCE_MS: '300',
  WA_TOKEN_ENC_KEY: 'c'.repeat(64),
};

for (const [k, v] of Object.entries(defaults)) {
  if (process.env[k] === undefined) process.env[k] = v;
}
// Valores que os testes comparam literalmente: não podem vir do .env local.
process.env.LOG_LEVEL = 'fatal';
// Debounce curto para os testes, mas maior que o tempo entre dois webhooks seguidos passando pela fila.
process.env.REPLY_DEBOUNCE_MS = '300';
process.env.JOB_POLL_MS = '50';
process.env.PUBLIC_BASE_URL = defaults.PUBLIC_BASE_URL;
process.env.PRIVACY_URL = defaults.PRIVACY_URL;
process.env.WA_MOCK = 'false'; // os testes mockam o client; nunca depender do .env local
// Conta do seed no banco de TESTE: fixa, independente do .env local (que pode apontar a entrada
// automática para outra conta, como a de demonstração). Para outro banco de teste, use TEST_SEED_*.
process.env.SEED_TENANT_SLUG = process.env.TEST_SEED_TENANT_SLUG || 'cliente-teste';
process.env.SEED_ADMIN_EMAIL = process.env.TEST_SEED_ADMIN_EMAIL || 'admin@exemplo.com.br';
process.env.SEED_ADMIN_PASSWORD = process.env.TEST_SEED_ADMIN_PASSWORD || 'Admin123456!';
process.env.SEED_WA_PHONE_NUMBER_ID = process.env.TEST_SEED_WA_PHONE_NUMBER_ID || '000000000000000';
// Modo normal nos testes, mesmo com o modo piloto ligado no .env local (o teste do piloto liga por conta própria).
process.env.BILLING_ENABLED = 'true';
process.env.SIGNUP_ENABLED = 'true';
process.env.BILLING_PROVIDER = 'mock';
process.env.EMAIL_PROVIDER = 'log';
process.env.DEV_AUTO_LOGIN = 'true'; // a integração testa a entrada automática local
