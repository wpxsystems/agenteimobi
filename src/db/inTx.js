'use strict';

const sequelize = require('./sequelize');
const AppError = require('../errors/AppError');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Abre uma transação com o contexto de tenant setado para o RLS.
 * `set_config(..., true)` = SET LOCAL: vale só dentro desta transação,
 * então uma conexão devolvida ao pool não carrega tenant de outra requisição.
 *
 * Toda query dentro de `fn` DEVE receber `{ transaction: t }`.
 */
async function inTx(tenantId, fn) {
  if (!tenantId || !UUID_RE.test(String(tenantId))) {
    throw new AppError('INTERNAL', 'Contexto de tenant inválido', 500);
  }
  return sequelize.transaction(async (t) => {
    await sequelize.query("SELECT set_config('app.tenant_id', :tenantId, true)", {
      replacements: { tenantId: String(tenantId) },
      transaction: t,
    });
    return fn(t);
  });
}

module.exports = inTx;
