'use strict';

/**
 * Migration 0006 — cadastro sozinho (item 1.1 do plano).
 *
 *   aim_user.email_verified_at : quando o e-mail foi confirmado. Usuários que já existiam ficam confirmados.
 *   aim_tenant.onboarding      : passos do primeiro uso que o servidor não consegue deduzir sozinho
 *                                (ex.: { "link_copiado": "2026-09-25T..." }).
 *   aim_user_token             : links de uso único (confirmar e-mail, redefinir senha). Guarda só o
 *                                hash SHA-256 do token; o token em si só existe no e-mail.
 *   aim_consent                : aceite dos termos e da política, com a versão e a data.
 *
 * aim_tenant passa a ter RLS. Até aqui o role da aplicação só lia a tabela; agora ele cria a
 * própria conta no cadastro e atualiza os passos do primeiro uso, então a escrita precisa de isolamento:
 *   - leitura liberada (webhook, login e link rastreado resolvem a conta por número/slug);
 *   - INSERT e UPDATE só na conta do contexto (app.tenant_id);
 *   - o role de migração (seed, scripts de operação) continua com acesso total.
 * O role da aplicação recebe INSERT/UPDATE só nas colunas que o cadastro e o primeiro uso usam.
 *
 * Idempotente e reversível.
 */

const APP_ROLE = process.env.DB_APP_ROLE || 'aim_app';
if (!/^[a-z_][a-z0-9_]*$/.test(APP_ROLE)) throw new Error('DB_APP_ROLE inválido');

const TENANT_EXPR = "NULLIF(current_setting('app.tenant_id', true), '')::uuid";

function tenantRls(table) {
  return `
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS ${table}_tenant_isolation ON ${table};
    CREATE POLICY ${table}_tenant_isolation ON ${table}
      USING (tenant_id = ${TENANT_EXPR})
      WITH CHECK (tenant_id = ${TENANT_EXPR});
  `;
}

async function up({ context: sequelize }) {
  await sequelize.transaction(async (t) => {
    const q = (sql) => sequelize.query(sql, { transaction: t });

    await q(`
      ALTER TABLE aim_user ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
      -- Usuários que já existiam ficam confirmados. aim_user tem RLS FORCE, que vale até para o dono da
      -- tabela quando ele não é superusuário: sem desligar o FORCE aqui, o UPDATE não enxergaria nenhuma linha.
      ALTER TABLE aim_user NO FORCE ROW LEVEL SECURITY;
      UPDATE aim_user SET email_verified_at = COALESCE(email_verified_at, created_at);
      ALTER TABLE aim_user FORCE ROW LEVEL SECURITY;

      ALTER TABLE aim_tenant ADD COLUMN IF NOT EXISTS onboarding jsonb NOT NULL DEFAULT '{}'::jsonb;

      CREATE TABLE IF NOT EXISTS aim_user_token (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL REFERENCES aim_tenant(id) ON DELETE CASCADE,
        user_id     uuid NOT NULL REFERENCES aim_user(id) ON DELETE CASCADE,
        purpose     text NOT NULL CHECK (purpose IN ('verificar_email', 'redefinir_senha')),
        token_hash  text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
        expires_at  timestamptz NOT NULL,
        used_at     timestamptz,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT aim_user_token_hash_uq UNIQUE (token_hash)
      );
      CREATE INDEX IF NOT EXISTS aim_user_token_user_idx ON aim_user_token (user_id, purpose) WHERE used_at IS NULL;

      CREATE TABLE IF NOT EXISTS aim_consent (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    uuid NOT NULL REFERENCES aim_tenant(id) ON DELETE CASCADE,
        user_id      uuid NOT NULL REFERENCES aim_user(id) ON DELETE CASCADE,
        document     text NOT NULL CHECK (document IN ('termos', 'privacidade')),
        version      text NOT NULL CHECK (version ~ '^[a-z0-9.-]{1,40}$'),
        accepted_at  timestamptz NOT NULL DEFAULT now(),
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS aim_consent_user_idx ON aim_consent (user_id, document);
    `);

    await q(tenantRls('aim_user_token'));
    await q(tenantRls('aim_consent'));

    await q(`
      ALTER TABLE aim_tenant ENABLE ROW LEVEL SECURITY;
      ALTER TABLE aim_tenant FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS aim_tenant_read ON aim_tenant;
      CREATE POLICY aim_tenant_read ON aim_tenant FOR SELECT USING (true);
      DROP POLICY IF EXISTS aim_tenant_insert_own ON aim_tenant;
      CREATE POLICY aim_tenant_insert_own ON aim_tenant FOR INSERT WITH CHECK (id = ${TENANT_EXPR});
      DROP POLICY IF EXISTS aim_tenant_update_own ON aim_tenant;
      CREATE POLICY aim_tenant_update_own ON aim_tenant FOR UPDATE
        USING (id = ${TENANT_EXPR}) WITH CHECK (id = ${TENANT_EXPR});
      DROP POLICY IF EXISTS aim_tenant_owner ON aim_tenant;
      CREATE POLICY aim_tenant_owner ON aim_tenant TO CURRENT_USER USING (true) WITH CHECK (true);

      GRANT INSERT (id, slug, name) ON aim_tenant TO ${APP_ROLE};
      GRANT UPDATE (onboarding, updated_at) ON aim_tenant TO ${APP_ROLE};
      GRANT SELECT, INSERT, UPDATE, DELETE ON aim_user_token, aim_consent TO ${APP_ROLE};
    `);
  });
}

async function down({ context: sequelize }) {
  await sequelize.transaction(async (t) => {
    await sequelize.query(
      `REVOKE INSERT (id, slug, name) ON aim_tenant FROM ${APP_ROLE};
       REVOKE UPDATE (onboarding, updated_at) ON aim_tenant FROM ${APP_ROLE};
       DROP POLICY IF EXISTS aim_tenant_read ON aim_tenant;
       DROP POLICY IF EXISTS aim_tenant_insert_own ON aim_tenant;
       DROP POLICY IF EXISTS aim_tenant_update_own ON aim_tenant;
       DROP POLICY IF EXISTS aim_tenant_owner ON aim_tenant;
       ALTER TABLE aim_tenant NO FORCE ROW LEVEL SECURITY;
       ALTER TABLE aim_tenant DISABLE ROW LEVEL SECURITY;
       DROP TABLE IF EXISTS aim_consent;
       DROP TABLE IF EXISTS aim_user_token;
       ALTER TABLE aim_tenant DROP COLUMN IF EXISTS onboarding;
       ALTER TABLE aim_user DROP COLUMN IF EXISTS email_verified_at;`,
      { transaction: t }
    );
  });
}

module.exports = { up, down };
