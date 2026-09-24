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
  REPLY_DEBOUNCE_MS: '50',
};

for (const [k, v] of Object.entries(defaults)) {
  if (process.env[k] === undefined) process.env[k] = v;
}
process.env.LOG_LEVEL = 'fatal';
process.env.REPLY_DEBOUNCE_MS = '50';
