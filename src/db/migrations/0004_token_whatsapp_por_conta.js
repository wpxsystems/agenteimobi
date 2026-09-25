'use strict';

/**
 * Migration 0004 — token do WhatsApp por conta.
 *
 *   wa_waba_id            : id da conta do WhatsApp Business (WABA) na Meta.
 *   wa_access_token_enc   : token de acesso cifrado com AES-256-GCM (src/services/crypto.js),
 *                           no formato "v1.<iv>.<tag>.<cifra>". O id da conta entra como dado
 *                           autenticado, então um token copiado para outra conta não decifra.
 *   wa_token_updated_at   : quando o token foi gravado.
 *
 * Sem token na conta, o envio usa o WA_ACCESS_TOKEN global (instalação de um cliente só).
 * O role da aplicação continua só lendo aim_tenant; o token é gravado pelo script
 * `npm run tenant:wa-token` (role de migração) até existir o fluxo de conexão pelo painel.
 * Idempotente e reversível.
 */

async function up({ context: sequelize }) {
  await sequelize.transaction(async (t) => {
    await sequelize.query(
      `ALTER TABLE aim_tenant ADD COLUMN IF NOT EXISTS wa_waba_id text CHECK (wa_waba_id ~ '^[0-9]{5,30}$');
       ALTER TABLE aim_tenant ADD COLUMN IF NOT EXISTS wa_access_token_enc text CHECK (wa_access_token_enc ~ '^v1\\.');
       ALTER TABLE aim_tenant ADD COLUMN IF NOT EXISTS wa_token_updated_at timestamptz;`,
      { transaction: t }
    );
  });
}

async function down({ context: sequelize }) {
  await sequelize.transaction(async (t) => {
    await sequelize.query(
      `ALTER TABLE aim_tenant
         DROP COLUMN IF EXISTS wa_waba_id,
         DROP COLUMN IF EXISTS wa_access_token_enc,
         DROP COLUMN IF EXISTS wa_token_updated_at;`,
      { transaction: t }
    );
  });
}

module.exports = { up, down };
