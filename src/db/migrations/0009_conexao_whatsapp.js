'use strict';

/**
 * Migration 0009 — conectar o WhatsApp pelo painel (item 1.2 do plano).
 *
 * O admin conecta o número pelo cadastro incorporado da Meta; a aplicação passa a gravar os campos
 * do WhatsApp da PRÓPRIA conta (a policy aim_tenant_update_own continua limitando à conta do contexto).
 * O token vai cifrado (AES-256-GCM, amarrado ao id da conta).
 *
 * Idempotente e reversível.
 */

const APP_ROLE = process.env.DB_APP_ROLE || 'aim_app';
if (!/^[a-z_][a-z0-9_]*$/.test(APP_ROLE)) throw new Error('DB_APP_ROLE inválido');

const COLUMNS = 'wa_phone_number_id, wa_display_phone, wa_waba_id, wa_access_token_enc, wa_token_updated_at';

async function up({ context: sequelize }) {
  await sequelize.transaction(async (t) => {
    await sequelize.query(`GRANT UPDATE (${COLUMNS}) ON aim_tenant TO ${APP_ROLE};`, { transaction: t });
  });
}

async function down({ context: sequelize }) {
  await sequelize.transaction(async (t) => {
    await sequelize.query(`REVOKE UPDATE (${COLUMNS}) ON aim_tenant FROM ${APP_ROLE};`, { transaction: t });
  });
}

module.exports = { up, down };
