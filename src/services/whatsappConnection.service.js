'use strict';

/**
 * Conectar e desconectar o WhatsApp da conta pelo painel (cadastro incorporado da Meta, item 1.2 do plano).
 * Ver docs/logica/conexao-whatsapp.md.
 *
 * Ordem da conexão (chamadas de rede fora de transação):
 *   1. admin com e-mail confirmado; número ainda não usado por outra conta
 *   2. code -> token de negócio da empresa
 *   3. assina o nosso app nos avisos da WABA
 *   4. registra o número na Cloud API com um PIN novo de 6 dígitos
 *   5. lê o número exibido
 *   6. grava na conta: ids, número e token cifrado
 */

const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../config/logger');
const inTx = require('../db/inTx');
const AppError = require('../errors/AppError');
const { sequelize, Tenant, User } = require('../models');
const { encrypt } = require('./crypto');
const meta = require('./whatsapp/meta');
const { accessTokenFor } = require('./whatsapp/client');

async function connect(tenantId, userId, { code, wabaId, phoneNumberId }) {
  if (!env.embeddedSignup) throw new AppError('WA_SIGNUP_DISABLED', 'Conexão pelo painel ainda não disponível', 503);
  const user = await inTx(tenantId, (t) => User.findByPk(userId, { transaction: t }));
  if (!user || !user.emailVerifiedAt) throw new AppError('EMAIL_NOT_VERIFIED', 'Confirme seu e-mail antes de conectar o WhatsApp', 409);
  const other = await Tenant.findOne({ where: { waPhoneNumberId: phoneNumberId } });
  if (other && other.id !== tenantId) throw new AppError('WA_NUMBER_IN_USE', 'Este número já está conectado a outra conta', 409);

  const token = await meta.exchangeCode(code);
  await meta.subscribeApp(wabaId, token);
  const pin = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  await meta.registerNumber(phoneNumberId, token, pin);
  const info = await meta.getPhoneInfo(phoneNumberId, token);
  if (!/^[0-9]{10,15}$/.test(info.displayPhone)) throw new AppError('WA_CONNECT_FAILED', 'A Meta devolveu um número em formato inesperado', 502);

  try {
    await inTx(tenantId, (t) =>
      sequelize.query(
        `UPDATE aim_tenant
            SET wa_phone_number_id = :phoneNumberId, wa_display_phone = :displayPhone, wa_waba_id = :wabaId,
                wa_access_token_enc = :enc, wa_token_updated_at = now(), updated_at = now()
          WHERE id = :tenantId`,
        { replacements: { tenantId, phoneNumberId, displayPhone: info.displayPhone, wabaId, enc: encrypt(token, tenantId) }, transaction: t }
      )
    );
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') throw new AppError('WA_NUMBER_IN_USE', 'Este número já está conectado a outra conta', 409);
    throw err;
  }
  logger.info({ tenantId }, 'WhatsApp conectado pelo painel');
  return info;
}

/** Situação da conexão. Com token, consulta a Meta ao vivo; se a Meta falhar, devolve o que está gravado. */
async function status(tenantId) {
  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant || !tenant.waPhoneNumberId) return { connected: false, signupAvailable: env.embeddedSignup };
  const base = { connected: true, signupAvailable: env.embeddedSignup, displayPhone: tenant.waDisplayPhone, ownToken: Boolean(tenant.waAccessTokenEnc) };
  if (env.waMock) return { ...base, live: false };
  try {
    const info = await meta.getPhoneInfo(tenant.waPhoneNumberId, accessTokenFor(tenant));
    return { ...base, ...info, live: true };
  } catch {
    return { ...base, live: false };
  }
}

/** Desconecta: tira a assinatura dos avisos (se der) e apaga número, ids e token da conta. */
async function disconnect(tenantId) {
  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant || !tenant.waPhoneNumberId) return;
  if (tenant.waWabaId && tenant.waAccessTokenEnc && !env.waMock) {
    try {
      await meta.unsubscribeApp(tenant.waWabaId, accessTokenFor(tenant));
    } catch (err) {
      logger.warn({ tenantId, code: err.code }, 'Não foi possível tirar a assinatura dos avisos na Meta; seguindo com a desconexão');
    }
  }
  await inTx(tenantId, (t) =>
    sequelize.query(
      `UPDATE aim_tenant
          SET wa_phone_number_id = NULL, wa_display_phone = NULL, wa_waba_id = NULL,
              wa_access_token_enc = NULL, wa_token_updated_at = now(), updated_at = now()
        WHERE id = :tenantId`,
      { replacements: { tenantId }, transaction: t }
    )
  );
  logger.info({ tenantId }, 'WhatsApp desconectado pelo painel');
}

/** Dados públicos para o painel abrir o cadastro incorporado (não são segredos). */
function signupConfig() {
  return env.embeddedSignup ? { appId: env.META_APP_ID, configId: env.META_ES_CONFIG_ID, graphVersion: env.WA_GRAPH_VERSION } : null;
}

module.exports = { connect, status, disconnect, signupConfig };
