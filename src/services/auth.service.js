'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Sequelize } = require('sequelize');
const env = require('../config/env');
const logger = require('../config/logger');
const inTx = require('../db/inTx');
const AppError = require('../errors/AppError');
const { Tenant, User, RefreshToken } = require('../models');

const BCRYPT_COST = 12;
// Hash fixo para comparar quando o usuário não existe (evita diferença de tempo que revela e-mails válidos).
const DUMMY_HASH = bcrypt.hashSync('dummy-password-not-used', BCRYPT_COST);

const hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_COST);

function signAccess(user) {
  return jwt.sign({ typ: 'access', tid: user.tenantId, role: user.role }, env.JWT_ACCESS_SECRET, {
    subject: user.id,
    expiresIn: env.JWT_ACCESS_TTL,
    algorithm: 'HS256',
  });
}

async function issueTokens(user, t) {
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
  await RefreshToken.create({ id: jti, tenantId: user.tenantId, userId: user.id, expiresAt }, { transaction: t });
  const refreshToken = jwt.sign({ typ: 'refresh', tid: user.tenantId, jti }, env.JWT_REFRESH_SECRET, {
    subject: user.id,
    expiresIn: `${env.JWT_REFRESH_TTL_DAYS}d`,
    algorithm: 'HS256',
  });
  return { accessToken: signAccess(user), refreshToken };
}

async function login({ tenant: slug, email, password }) {
  const tenant = await Tenant.findOne({ where: { slug, isActive: true } });
  const fail = () => AppError.unauthorized('Credenciais inválidas');

  if (!tenant) {
    await bcrypt.compare(password, DUMMY_HASH);
    throw fail();
  }

  return inTx(tenant.id, async (t) => {
    const user = await User.scope('withPassword').findOne({
      where: Sequelize.where(Sequelize.fn('lower', Sequelize.col('email')), email.toLowerCase()),
      transaction: t,
    });
    const ok = await bcrypt.compare(password, user?.passwordHash || DUMMY_HASH);
    if (!user || !ok || !user.isActive) throw fail();

    const tokens = await issueTokens(user, t);
    return { user, ...tokens };
  });
}

function verifyRefresh(token) {
  try {
    const p = jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
    if (p.typ !== 'refresh' || !p.jti || !p.tid || !p.sub) throw new Error('payload');
    return p;
  } catch {
    throw AppError.unauthorized('Refresh token inválido');
  }
}

/** Rotação de refresh token. Reuso de token já revogado = possível roubo -> revoga todos do usuário. */
async function refresh(token) {
  const p = verifyRefresh(token);
  const result = await inTx(p.tid, async (t) => {
    const stored = await RefreshToken.findByPk(p.jti, { transaction: t, lock: t.LOCK.UPDATE });
    if (!stored || stored.userId !== p.sub) return { error: 'invalid' };
    if (stored.revokedAt) {
      await RefreshToken.update({ revokedAt: new Date() }, { where: { userId: p.sub, revokedAt: null }, transaction: t });
      return { error: 'reuse' };
    }
    if (stored.expiresAt < new Date()) return { error: 'invalid' };

    const user = await User.findByPk(p.sub, { transaction: t });
    if (!user || !user.isActive) return { error: 'invalid' };

    await stored.update({ revokedAt: new Date() }, { transaction: t });
    return { tokens: await issueTokens(user, t) };
  });
  // O throw fica fora da transação para a revogação em massa (reuso) ser gravada.
  if (result.error === 'reuse') {
    logger.warn({ userId: p.sub }, 'Reuso de refresh token detectado; sessões revogadas');
  }
  if (result.error) throw AppError.unauthorized('Refresh token inválido');
  return result.tokens;
}

async function logout(token) {
  let p;
  try {
    p = verifyRefresh(token);
  } catch {
    return; // logout é idempotente
  }
  await inTx(p.tid, (t) =>
    RefreshToken.update({ revokedAt: new Date() }, { where: { id: p.jti, userId: p.sub, revokedAt: null }, transaction: t })
  );
}

/**
 * Entrada automática do ambiente LOCAL: emite a sessão do admin do seed sem senha.
 * Só existe com DEV_AUTO_LOGIN=true fora de produção; a rota nem é montada em produção.
 * Os tokens são os mesmos do login normal, então todo o resto (RLS, refresh, logout) continua igual.
 */
async function devLogin() {
  if (!env.devAutoLogin) throw AppError.notFound('Rota');
  const tenant = await Tenant.findOne({ where: { slug: env.SEED_TENANT_SLUG || '', isActive: true } });
  if (!tenant) throw new AppError('DEV_LOGIN_UNAVAILABLE', 'Conta do seed não encontrada: rode o seed', 409);
  return inTx(tenant.id, async (t) => {
    const where = env.SEED_ADMIN_EMAIL
      ? Sequelize.where(Sequelize.fn('lower', Sequelize.col('email')), env.SEED_ADMIN_EMAIL.toLowerCase())
      : { role: 'admin' };
    const user = await User.findOne({ where, order: [['createdAt', 'ASC']], transaction: t });
    if (!user || !user.isActive) throw new AppError('DEV_LOGIN_UNAVAILABLE', 'Admin do seed não encontrado: rode o seed', 409);
    const tokens = await issueTokens(user, t);
    return { user, ...tokens };
  });
}

module.exports = { login, refresh, logout, hashPassword, devLogin };
