'use strict';

/**
 * Migration 0008 — LGPD mínimo para vender (item 1.5 do plano).
 *
 *   aim_lead.anonymized_at      : lead anonimizado (a pedido ou pela retenção). Mensagens apagadas,
 *                                 telefone trocado por um número fictício, fatos e textos limpos.
 *                                 Ficam só classificação, origem, imóvel e datas, para os números do funil.
 *   aim_tenant.retention_months : por quantos meses sem conversa os dados do lead são guardados (3 a 60, padrão 12).
 *   aim_privacy_request         : registro de exportação e exclusão feitas a pedido do titular.
 *                                 Guarda o hash do telefone, nunca o telefone.
 *   aim_tenant                  : a conta pode se excluir (DELETE só da própria conta).
 *
 * Idempotente e reversível.
 */

const APP_ROLE = process.env.DB_APP_ROLE || 'aim_app';
if (!/^[a-z_][a-z0-9_]*$/.test(APP_ROLE)) throw new Error('DB_APP_ROLE inválido');

const TENANT_EXPR = "NULLIF(current_setting('app.tenant_id', true), '')::uuid";

async function up({ context: sequelize }) {
  await sequelize.transaction(async (t) => {
    await sequelize.query(
      `ALTER TABLE aim_lead ADD COLUMN IF NOT EXISTS anonymized_at timestamptz;
       ALTER TABLE aim_tenant ADD COLUMN IF NOT EXISTS retention_months integer NOT NULL DEFAULT 12
         CHECK (retention_months BETWEEN 3 AND 60);

       CREATE TABLE IF NOT EXISTS aim_privacy_request (
         id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         tenant_id     uuid NOT NULL REFERENCES aim_tenant(id) ON DELETE CASCADE,
         kind          text NOT NULL CHECK (kind IN ('exportacao', 'exclusao')),
         subject_ref   text NOT NULL CHECK (subject_ref ~ '^[0-9a-f]{64}$'),
         requested_by  uuid REFERENCES aim_user(id) ON DELETE SET NULL,
         created_at    timestamptz NOT NULL DEFAULT now(),
         updated_at    timestamptz NOT NULL DEFAULT now()
       );
       ALTER TABLE aim_privacy_request ENABLE ROW LEVEL SECURITY;
       ALTER TABLE aim_privacy_request FORCE ROW LEVEL SECURITY;
       DROP POLICY IF EXISTS aim_privacy_request_tenant_isolation ON aim_privacy_request;
       CREATE POLICY aim_privacy_request_tenant_isolation ON aim_privacy_request
         USING (tenant_id = ${TENANT_EXPR}) WITH CHECK (tenant_id = ${TENANT_EXPR});
       GRANT SELECT, INSERT ON aim_privacy_request TO ${APP_ROLE};

       DROP POLICY IF EXISTS aim_tenant_delete_own ON aim_tenant;
       CREATE POLICY aim_tenant_delete_own ON aim_tenant FOR DELETE USING (id = ${TENANT_EXPR});
       GRANT DELETE ON aim_tenant TO ${APP_ROLE};
       GRANT UPDATE (retention_months) ON aim_tenant TO ${APP_ROLE};`,
      { transaction: t }
    );
  });
}

async function down({ context: sequelize }) {
  await sequelize.transaction(async (t) => {
    await sequelize.query(
      `REVOKE DELETE ON aim_tenant FROM ${APP_ROLE};
       REVOKE UPDATE (retention_months) ON aim_tenant FROM ${APP_ROLE};
       DROP POLICY IF EXISTS aim_tenant_delete_own ON aim_tenant;
       DROP TABLE IF EXISTS aim_privacy_request;
       ALTER TABLE aim_tenant DROP COLUMN IF EXISTS retention_months;
       ALTER TABLE aim_lead DROP COLUMN IF EXISTS anonymized_at;`,
      { transaction: t }
    );
  });
}

module.exports = { up, down };
