'use strict';

/**
 * Migration 0002 — funcionalidades do agente:
 *   - handoff_summary: resumo da conversa para o corretor, gravado na transferência;
 *   - open_questions: perguntas do lead que a IA não soube responder com o cadastro do imóvel.
 * Idempotente (IF NOT EXISTS) e reversível. A tabela já tem RLS FORCE e os GRANTs valem para colunas novas.
 */

async function up({ context: sequelize }) {
  await sequelize.transaction(async (t) => {
    await sequelize.query(
      `ALTER TABLE aim_lead ADD COLUMN IF NOT EXISTS handoff_summary text;
       ALTER TABLE aim_lead ADD COLUMN IF NOT EXISTS open_questions jsonb NOT NULL DEFAULT '[]'::jsonb;`,
      { transaction: t }
    );
  });
}

async function down({ context: sequelize }) {
  await sequelize.transaction(async (t) => {
    await sequelize.query(
      `ALTER TABLE aim_lead DROP COLUMN IF EXISTS handoff_summary, DROP COLUMN IF EXISTS open_questions;`,
      { transaction: t }
    );
  });
}

module.exports = { up, down };
