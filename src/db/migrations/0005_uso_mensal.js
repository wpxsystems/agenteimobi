'use strict';

/**
 * Migration 0005 — registro de uso por conta e por mês (base dos limites por plano).
 *
 *   aim_usage_month: contadores do mês (fuso de São Paulo), uma linha por conta e mês.
 *     conversations  : leads diferentes que a IA atendeu no mês (conta uma vez por lead por mês)
 *     ai_calls       : chamadas à IA (uma por rodada de conversa)
 *     templates_sent : templates enviados (pagos na Meta)
 *     ad_copies      : textos de anúncio gerados (item 3.2 do plano)
 *   aim_lead.usage_month: mês em que o lead já foi contado como conversa.
 *
 * Idempotente e reversível.
 */

const APP_ROLE = process.env.DB_APP_ROLE || 'aim_app';
if (!/^[a-z_][a-z0-9_]*$/.test(APP_ROLE)) throw new Error('DB_APP_ROLE inválido');

async function up({ context: sequelize }) {
  await sequelize.transaction(async (t) => {
    await sequelize.query(
      `CREATE TABLE IF NOT EXISTS aim_usage_month (
         id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         tenant_id       uuid NOT NULL REFERENCES aim_tenant(id) ON DELETE CASCADE,
         month           date NOT NULL CHECK (extract(day FROM month) = 1),
         conversations   integer NOT NULL DEFAULT 0 CHECK (conversations >= 0),
         ai_calls        integer NOT NULL DEFAULT 0 CHECK (ai_calls >= 0),
         templates_sent  integer NOT NULL DEFAULT 0 CHECK (templates_sent >= 0),
         ad_copies       integer NOT NULL DEFAULT 0 CHECK (ad_copies >= 0),
         created_at      timestamptz NOT NULL DEFAULT now(),
         updated_at      timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT aim_usage_month_tenant_month_uq UNIQUE (tenant_id, month)
       );

       ALTER TABLE aim_usage_month ENABLE ROW LEVEL SECURITY;
       ALTER TABLE aim_usage_month FORCE ROW LEVEL SECURITY;
       DROP POLICY IF EXISTS aim_usage_month_tenant_isolation ON aim_usage_month;
       CREATE POLICY aim_usage_month_tenant_isolation ON aim_usage_month
         USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
       GRANT SELECT, INSERT, UPDATE ON aim_usage_month TO ${APP_ROLE};

       ALTER TABLE aim_lead ADD COLUMN IF NOT EXISTS usage_month date;`,
      { transaction: t }
    );
  });
}

async function down({ context: sequelize }) {
  await sequelize.transaction(async (t) => {
    await sequelize.query(
      `ALTER TABLE aim_lead DROP COLUMN IF EXISTS usage_month;
       DROP TABLE IF EXISTS aim_usage_month;`,
      { transaction: t }
    );
  });
}

module.exports = { up, down };
