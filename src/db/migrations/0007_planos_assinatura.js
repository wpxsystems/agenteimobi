'use strict';

/**
 * Migration 0007 — planos e assinatura (itens 1.3 e 1.4 do plano).
 *
 *   aim_subscription : uma linha por conta. Plano, situação e datas. Os ids do provedor de cobrança
 *                      ficam aqui; CPF/CNPJ NÃO: vai direto para o provedor e não é guardado.
 *   aim_billing_event: ids dos avisos do provedor já processados (o provedor reenvia avisos).
 *                      Sem tenant_id e sem conteúdo: só o id do aviso, para não processar duas vezes.
 *
 * Contas que já existem ficam no plano 'interno' (sem limite): clientes atuais não são afetados.
 * Conta sem linha de assinatura (criada pelo seed ou à mão) também é tratada como 'interno'.
 *
 * Idempotente e reversível.
 */

const APP_ROLE = process.env.DB_APP_ROLE || 'aim_app';
if (!/^[a-z_][a-z0-9_]*$/.test(APP_ROLE)) throw new Error('DB_APP_ROLE inválido');

const TENANT_EXPR = "NULLIF(current_setting('app.tenant_id', true), '')::uuid";

async function up({ context: sequelize }) {
  await sequelize.transaction(async (t) => {
    const q = (sql) => sequelize.query(sql, { transaction: t });
    await q(`
      CREATE TABLE IF NOT EXISTS aim_subscription (
        id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id                 uuid NOT NULL REFERENCES aim_tenant(id) ON DELETE CASCADE,
        plan                      text NOT NULL CHECK (plan ~ '^[a-z_]{3,30}$'),
        status                    text NOT NULL CHECK (status IN ('teste', 'ativa', 'inadimplente', 'cancelada')),
        pending_plan              text CHECK (pending_plan ~ '^[a-z_]{3,30}$'),
        trial_ends_at             timestamptz,
        current_period_end        timestamptz,
        grace_until               timestamptz,
        provider                  text CHECK (provider IN ('asaas', 'mock')),
        provider_customer_id      text CHECK (provider_customer_id ~ '^[A-Za-z0-9_-]{1,80}$'),
        provider_subscription_id  text CHECK (provider_subscription_id ~ '^[A-Za-z0-9_-]{1,80}$'),
        created_at                timestamptz NOT NULL DEFAULT now(),
        updated_at                timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT aim_subscription_tenant_uq UNIQUE (tenant_id),
        CONSTRAINT aim_subscription_trial_ck CHECK (status <> 'teste' OR trial_ends_at IS NOT NULL)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS aim_subscription_provider_sub_uq
        ON aim_subscription (provider, provider_subscription_id) WHERE provider_subscription_id IS NOT NULL;

      ALTER TABLE aim_subscription ENABLE ROW LEVEL SECURITY;
      ALTER TABLE aim_subscription FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS aim_subscription_tenant_isolation ON aim_subscription;
      CREATE POLICY aim_subscription_tenant_isolation ON aim_subscription
        USING (tenant_id = ${TENANT_EXPR}) WITH CHECK (tenant_id = ${TENANT_EXPR});
      DROP POLICY IF EXISTS aim_subscription_owner ON aim_subscription;
      CREATE POLICY aim_subscription_owner ON aim_subscription TO CURRENT_USER USING (true) WITH CHECK (true);
      GRANT SELECT, INSERT, UPDATE ON aim_subscription TO ${APP_ROLE};

      CREATE TABLE IF NOT EXISTS aim_billing_event (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        provider     text NOT NULL CHECK (provider IN ('asaas', 'mock')),
        event_id     text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
        event_type   text NOT NULL CHECK (event_type ~ '^[A-Z_]{1,60}$'),
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT aim_billing_event_uq UNIQUE (provider, event_id)
      );
      GRANT SELECT, INSERT ON aim_billing_event TO ${APP_ROLE};

      -- Contas atuais: plano interno, sem limite.
      INSERT INTO aim_subscription (tenant_id, plan, status)
      SELECT id, 'interno', 'ativa' FROM aim_tenant
      ON CONFLICT (tenant_id) DO NOTHING;
    `);
  });
}

async function down({ context: sequelize }) {
  await sequelize.transaction(async (t) => {
    await sequelize.query('DROP TABLE IF EXISTS aim_billing_event; DROP TABLE IF EXISTS aim_subscription;', { transaction: t });
  });
}

module.exports = { up, down };
