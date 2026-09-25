'use strict';

/**
 * Migration 0010 — fase 2 do plano: controle para o dono.
 *
 *   aim_tenant.timezone            : fuso da conta (resumo às 8h locais, horários de visita)
 *   aim_tenant.handoff_sla_minutes : quanto um lead transferido pode esperar o corretor antes de virar aviso
 *   aim_tenant.digest_enabled      : manda (ou não) o resumo diário no WhatsApp do dono
 *   aim_tenant.visit_schedule      : grade semanal de visitas { slotMinutes, days: { "0".."6": ["09:00-12:00", ...] } }
 *
 *   aim_alert  (2.2): avisos de qualidade. Um aberto por lead+tipo (ou imóvel+tipo). Sem texto do lead:
 *                     details guarda só números, códigos e perguntas já agregadas do cadastro.
 *   aim_digest (2.1): um resumo por conta por dia local (idempotência do envio). Só contagens.
 *   aim_visit  (2.3): visitas. Um horário por imóvel e uma visita agendada por lead.
 *
 * Idempotente e reversível.
 */

const APP_ROLE = process.env.DB_APP_ROLE || 'aim_app';
if (!/^[a-z_][a-z0-9_]*$/.test(APP_ROLE)) throw new Error('DB_APP_ROLE inválido');

const TENANT_EXPR = "NULLIF(current_setting('app.tenant_id', true), '')::uuid";
const DEFAULT_SCHEDULE = JSON.stringify({
  slotMinutes: 60,
  days: { 1: ['09:00-12:00', '14:00-18:00'], 2: ['09:00-12:00', '14:00-18:00'], 3: ['09:00-12:00', '14:00-18:00'], 4: ['09:00-12:00', '14:00-18:00'], 5: ['09:00-12:00', '14:00-18:00'], 6: ['09:00-12:00'] },
});

const rls = (table) => `
  ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS ${table}_tenant_isolation ON ${table};
  CREATE POLICY ${table}_tenant_isolation ON ${table}
    USING (tenant_id = ${TENANT_EXPR}) WITH CHECK (tenant_id = ${TENANT_EXPR});`;

async function up({ context: sequelize }) {
  await sequelize.transaction(async (t) => {
    const q = (sql) => sequelize.query(sql, { transaction: t });
    await q(`
      ALTER TABLE aim_tenant ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'America/Sao_Paulo'
        CHECK (timezone ~ '^[A-Za-z_]+(/[A-Za-z_]+){1,2}$');
      ALTER TABLE aim_tenant ADD COLUMN IF NOT EXISTS handoff_sla_minutes integer NOT NULL DEFAULT 120
        CHECK (handoff_sla_minutes BETWEEN 15 AND 1440);
      ALTER TABLE aim_tenant ADD COLUMN IF NOT EXISTS digest_enabled boolean NOT NULL DEFAULT true;
      ALTER TABLE aim_tenant ADD COLUMN IF NOT EXISTS visit_schedule jsonb NOT NULL DEFAULT '${DEFAULT_SCHEDULE}'::jsonb;
      GRANT UPDATE (timezone, handoff_sla_minutes, digest_enabled, visit_schedule) ON aim_tenant TO ${APP_ROLE};
      -- Quando o lead registrou a última dúvida NOVA (o aviso de cadastro incompleto compara com a edição do imóvel).
      ALTER TABLE aim_lead ADD COLUMN IF NOT EXISTS open_questions_at timestamptz;
      UPDATE aim_lead SET open_questions_at = updated_at WHERE open_questions_at IS NULL AND jsonb_array_length(open_questions) > 0;

      CREATE TABLE IF NOT EXISTS aim_alert (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    uuid NOT NULL REFERENCES aim_tenant(id) ON DELETE CASCADE,
        lead_id      uuid REFERENCES aim_lead(id) ON DELETE CASCADE,
        property_id  uuid REFERENCES aim_property(id) ON DELETE CASCADE,
        kind         text NOT NULL CHECK (kind IN ('lead_sem_retorno', 'sem_resposta', 'falha_envio', 'ia_invalida', 'falha_resposta', 'cadastro_incompleto')),
        details      jsonb NOT NULL DEFAULT '{}'::jsonb,
        resolved_at  timestamptz,
        resolved_by  text CHECK (resolved_by IN ('automatico', 'usuario')),
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT aim_alert_target_ck CHECK (lead_id IS NOT NULL OR property_id IS NOT NULL)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS aim_alert_lead_open_uq ON aim_alert (lead_id, kind) WHERE resolved_at IS NULL AND lead_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS aim_alert_property_open_uq ON aim_alert (property_id, kind) WHERE resolved_at IS NULL AND lead_id IS NULL;
      CREATE INDEX IF NOT EXISTS aim_alert_tenant_open_idx ON aim_alert (tenant_id, created_at DESC) WHERE resolved_at IS NULL;

      CREATE TABLE IF NOT EXISTS aim_digest (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL REFERENCES aim_tenant(id) ON DELETE CASCADE,
        day         date NOT NULL,
        counts      jsonb NOT NULL DEFAULT '{}'::jsonb,
        delivery    text NOT NULL CHECK (delivery IN ('whatsapp', 'so_painel', 'nada_relevante', 'falhou')),
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT aim_digest_tenant_day_uq UNIQUE (tenant_id, day)
      );

      CREATE TABLE IF NOT EXISTS aim_visit (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL REFERENCES aim_tenant(id) ON DELETE CASCADE,
        lead_id           uuid NOT NULL REFERENCES aim_lead(id) ON DELETE CASCADE,
        property_id       uuid NOT NULL REFERENCES aim_property(id) ON DELETE CASCADE,
        starts_at         timestamptz NOT NULL,
        ends_at           timestamptz NOT NULL,
        status            text NOT NULL DEFAULT 'agendada' CHECK (status IN ('agendada', 'cancelada', 'realizada', 'nao_compareceu')),
        created_by        text NOT NULL CHECK (created_by IN ('assistente', 'corretor')),
        reminder_sent_at  timestamptz,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT aim_visit_period_ck CHECK (ends_at > starts_at)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS aim_visit_property_slot_uq ON aim_visit (tenant_id, property_id, starts_at) WHERE status = 'agendada';
      CREATE UNIQUE INDEX IF NOT EXISTS aim_visit_lead_open_uq ON aim_visit (lead_id) WHERE status = 'agendada';
      CREATE INDEX IF NOT EXISTS aim_visit_tenant_start_idx ON aim_visit (tenant_id, starts_at);
    `);
    await q(rls('aim_alert'));
    await q(rls('aim_digest'));
    await q(rls('aim_visit'));
    await q(`GRANT SELECT, INSERT, UPDATE, DELETE ON aim_alert, aim_digest, aim_visit TO ${APP_ROLE};`);
  });
}

async function down({ context: sequelize }) {
  await sequelize.transaction(async (t) => {
    await sequelize.query(
      `DROP TABLE IF EXISTS aim_visit; DROP TABLE IF EXISTS aim_digest; DROP TABLE IF EXISTS aim_alert;
       ALTER TABLE aim_lead DROP COLUMN IF EXISTS open_questions_at;
       REVOKE UPDATE (timezone, handoff_sla_minutes, digest_enabled, visit_schedule) ON aim_tenant FROM ${APP_ROLE};
       ALTER TABLE aim_tenant DROP COLUMN IF EXISTS visit_schedule, DROP COLUMN IF EXISTS digest_enabled,
         DROP COLUMN IF EXISTS handoff_sla_minutes, DROP COLUMN IF EXISTS timezone;`,
      { transaction: t }
    );
  });
}

module.exports = { up, down };
