'use strict';

/**
 * Conta: cadastro sozinho, confirmação de e-mail, redefinição de senha e primeiros passos.
 *
 * Links de uso único: o token é "<id da conta>.<32 bytes aleatórios em base64url>". O id da conta
 * diz em qual contexto de RLS procurar; o banco guarda só o SHA-256 do token inteiro.
 * Pedir um link novo invalida os anteriores do mesmo tipo.
 */

const crypto = require('crypto');
const { QueryTypes, Sequelize } = require('sequelize');
const env = require('../config/env');
const logger = require('../config/logger');
const legal = require('../config/legal');
const inTx = require('../db/inTx');
const AppError = require('../errors/AppError');
const { sequelize, Tenant, User, RefreshToken, Property, Lead } = require('../models');
const { hashPassword, issueTokens } = require('./auth.service');
const email = require('./email.service');
const { isValidTimezone } = require('./time');
const billing = require('./billing.service');
const whatsappConnection = require('./whatsappConnection.service');

const VERIFY_TTL_MS = 48 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Endereços que confundiriam com rotas ou com a própria marca.
const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'painel', 'www', 'imobi', 'suporte', 'ajuda', 'login', 'cadastro',
  'conta', 'contas', 'webhook', 'webhooks', 'termos', 'privacidade', 'status', 'health', 'teste',
]);

/** Passos do primeiro uso, na ordem em que aparecem no painel. */
const ONBOARDING_STEPS = ['conta', 'email', 'imovel', 'whatsapp', 'link', 'teste'];
const MARKABLE_STEPS = { link: 'link_copiado', teste: 'teste_feito' };

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function newToken(tenantId) {
  const token = `${tenantId}.${crypto.randomBytes(32).toString('base64url')}`;
  return { token, hash: sha256(token) };
}

/** @returns {{ tenantId: string, hash: string } | null} */
function parseToken(token) {
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''));
  if (!m || !UUID_RE.test(m[1])) return null;
  return { tenantId: m[1], hash: sha256(token) };
}

const invalidToken = () => new AppError('TOKEN_INVALID', 'Link inválido ou expirado. Peça um novo.', 400);

const panelUrl = (param, token) => `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/painel/?${param}=${encodeURIComponent(token)}`;

/** Cria um link de uso único e invalida os anteriores do mesmo tipo. Dentro de inTx da conta. */
async function createUserToken(t, { tenantId, userId, purpose, ttlMs }) {
  await sequelize.query(
    `UPDATE aim_user_token SET used_at = now(), updated_at = now()
      WHERE user_id = :userId AND purpose = :purpose AND used_at IS NULL`,
    { replacements: { userId, purpose }, transaction: t }
  );
  const { token, hash } = newToken(tenantId);
  await sequelize.query(
    `INSERT INTO aim_user_token (tenant_id, user_id, purpose, token_hash, expires_at)
     VALUES (:tenantId, :userId, :purpose, :hash, now() + make_interval(secs => :ttl))`,
    { replacements: { tenantId, userId, purpose, hash, ttl: ttlMs / 1000 }, transaction: t }
  );
  return token;
}

/** Marca o link como usado e devolve o usuário dono, ou null se inválido/expirado/já usado. */
async function consumeUserToken(t, hash, purpose) {
  const [row] = await sequelize.query(
    `SELECT id, user_id AS "userId" FROM aim_user_token
      WHERE token_hash = :hash AND purpose = :purpose AND used_at IS NULL AND expires_at > now()
      FOR UPDATE`,
    { replacements: { hash, purpose }, type: QueryTypes.SELECT, transaction: t }
  );
  if (!row) return null;
  await sequelize.query('UPDATE aim_user_token SET used_at = now(), updated_at = now() WHERE id = :id', {
    replacements: { id: row.id },
    transaction: t,
  });
  return row.userId;
}

async function safeSend(fn, args, what) {
  try {
    await fn(args);
  } catch (err) {
    // A conta/pedido continua válido; a pessoa pode pedir o e-mail de novo.
    logger.error({ code: err.code, to: email.maskEmail(args.to) }, `Falha ao enviar e-mail de ${what}`);
  }
}

/**
 * Cadastro: cria a conta, o primeiro admin, o registro de aceite e o link de confirmação,
 * tudo numa transação no contexto da conta nova. Já devolve a sessão (a pessoa entra direto).
 */
async function signup({ accountName, slug, name, email: rawEmail, password }) {
  // Modo piloto: contas só pelo comando `npm run conta -- criar`.
  if (!env.signupEnabled) throw new AppError('SIGNUP_CLOSED', 'O cadastro está fechado no momento', 403);
  if (RESERVED_SLUGS.has(slug)) throw new AppError('SLUG_TAKEN', 'Esse endereço de conta não está disponível', 409);
  const tenantId = crypto.randomUUID();
  const userEmail = rawEmail.trim().toLowerCase();
  const passwordHash = await hashPassword(password);

  let result;
  try {
    result = await inTx(tenantId, async (t) => {
      await sequelize.query('INSERT INTO aim_tenant (id, slug, name) VALUES (:id, :slug, :name)', {
        replacements: { id: tenantId, slug, name: accountName },
        transaction: t,
      });
      const user = await User.create({ tenantId, name, email: userEmail, passwordHash, role: 'admin' }, { transaction: t });
      await sequelize.query(
        `INSERT INTO aim_consent (tenant_id, user_id, document, version)
         VALUES (:tenantId, :userId, 'termos', :terms), (:tenantId, :userId, 'privacidade', :privacy)`,
        { replacements: { tenantId, userId: user.id, terms: legal.TERMS_VERSION, privacy: legal.PRIVACY_VERSION }, transaction: t }
      );
      await billing.createTrial(tenantId, t); // teste grátis começa junto com a conta
      const verifyToken = await createUserToken(t, { tenantId, userId: user.id, purpose: 'verificar_email', ttlMs: VERIFY_TTL_MS });
      const tokens = await issueTokens(user, t);
      return { user, tokens, verifyToken };
    });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      throw new AppError('SLUG_TAKEN', 'Esse endereço de conta já está em uso', 409);
    }
    throw err;
  }

  await safeSend(email.sendEmailVerification, { to: userEmail, name, url: panelUrl('verificar', result.verifyToken) }, 'confirmação');
  logger.info({ tenantId }, 'Conta criada pelo cadastro');
  return { user: result.user, ...result.tokens };
}

async function verifyEmail(token) {
  const parsed = parseToken(token);
  if (!parsed) throw invalidToken();
  const ok = await inTx(parsed.tenantId, async (t) => {
    const userId = await consumeUserToken(t, parsed.hash, 'verificar_email');
    if (!userId) return false;
    await sequelize.query(
      'UPDATE aim_user SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = :userId',
      { replacements: { userId }, transaction: t }
    );
    return true;
  });
  if (!ok) throw invalidToken();
}

/** Reenvia a confirmação para o usuário logado. */
async function resendVerification(tenantId, userId) {
  const out = await inTx(tenantId, async (t) => {
    const user = await User.findByPk(userId, { transaction: t });
    if (!user || !user.isActive) throw AppError.unauthorized();
    if (user.emailVerifiedAt) return { alreadyVerified: true };
    const token = await createUserToken(t, { tenantId, userId, purpose: 'verificar_email', ttlMs: VERIFY_TTL_MS });
    return { user, token };
  });
  if (out.alreadyVerified) return { alreadyVerified: true };
  await safeSend(email.sendEmailVerification, { to: out.user.email, name: out.user.name, url: panelUrl('verificar', out.token) }, 'confirmação');
  return { alreadyVerified: false };
}

/**
 * Pedido de nova senha. Sempre termina igual para quem chama (202), exista ou não a conta ou o e-mail:
 * a resposta não revela quem tem cadastro.
 */
async function forgotPassword({ tenant: slug, email: rawEmail }) {
  const tenant = await Tenant.findOne({ where: { slug, isActive: true } });
  if (!tenant) return;
  const out = await inTx(tenant.id, async (t) => {
    const user = await User.findOne({
      where: Sequelize.where(Sequelize.fn('lower', Sequelize.col('email')), rawEmail.trim().toLowerCase()),
      transaction: t,
    });
    if (!user || !user.isActive) return null;
    const token = await createUserToken(t, { tenantId: tenant.id, userId: user.id, purpose: 'redefinir_senha', ttlMs: RESET_TTL_MS });
    return { user, token };
  });
  if (!out) return;
  await safeSend(email.sendPasswordReset, { to: out.user.email, name: out.user.name, url: panelUrl('redefinir', out.token) }, 'redefinição de senha');
}

/** Troca a senha pelo link. Encerra todas as sessões abertas e confirma o e-mail (o link chegou nele). */
async function resetPassword({ token, password }) {
  const parsed = parseToken(token);
  if (!parsed) throw invalidToken();
  const passwordHash = await hashPassword(password);
  const ok = await inTx(parsed.tenantId, async (t) => {
    const userId = await consumeUserToken(t, parsed.hash, 'redefinir_senha');
    if (!userId) return false;
    await sequelize.query(
      `UPDATE aim_user SET password_hash = :passwordHash, email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
        WHERE id = :userId`,
      { replacements: { userId, passwordHash }, transaction: t }
    );
    await RefreshToken.update({ revokedAt: new Date() }, { where: { userId, revokedAt: null }, transaction: t });
    return true;
  });
  if (!ok) throw invalidToken();
}

/** Dados da conta, do usuário logado e dos primeiros passos (deduzidos do estado real). */
async function getAccount(tenantId, userId) {
  return inTx(tenantId, async (t) => {
    const tenant = await Tenant.findByPk(tenantId, { transaction: t });
    const user = await User.findByPk(userId, { transaction: t });
    if (!tenant || !user) throw AppError.unauthorized();
    const [properties, leads] = await Promise.all([Property.count({ transaction: t }), Lead.count({ transaction: t })]);
    const flags = tenant.onboarding || {};
    const done = {
      conta: true,
      email: Boolean(user.emailVerifiedAt),
      imovel: properties > 0,
      whatsapp: Boolean(tenant.waPhoneNumberId),
      link: Boolean(flags.link_copiado),
      teste: leads > 0 || Boolean(flags.teste_feito),
    };
    const steps = ONBOARDING_STEPS.map((key) => ({ key, done: done[key] }));
    return {
      tenant,
      user,
      onboarding: { steps, completed: steps.every((s) => s.done) },
      whatsappSignup: whatsappConnection.signupConfig(),
    };
  });
}

/** Rotina da conta (admin): fuso, prazo para o corretor responder e resumo diário ligado/desligado. */
async function setRoutine(tenantId, { timezone, handoffSlaMinutes, digestEnabled }) {
  if (timezone !== undefined && !isValidTimezone(timezone)) {
    throw AppError.validation([{ path: 'timezone', message: 'Fuso horário inválido' }]);
  }
  const sets = [];
  const replacements = { tenantId };
  if (timezone !== undefined) { sets.push('timezone = :timezone'); replacements.timezone = timezone; }
  if (handoffSlaMinutes !== undefined) { sets.push('handoff_sla_minutes = :sla'); replacements.sla = handoffSlaMinutes; }
  if (digestEnabled !== undefined) { sets.push('digest_enabled = :digest'); replacements.digest = digestEnabled; }
  await inTx(tenantId, (t) =>
    sequelize.query(`UPDATE aim_tenant SET ${sets.join(', ')}, updated_at = now() WHERE id = :tenantId`, { replacements, transaction: t })
  );
}

/** Marca um passo que o servidor não consegue deduzir (copiar o link, testar). Idempotente. */
async function markOnboardingStep(tenantId, step) {
  const flag = MARKABLE_STEPS[step];
  if (!flag) throw AppError.validation([{ path: 'step', message: 'Passo não pode ser marcado' }]);
  await inTx(tenantId, (t) =>
    sequelize.query(
      `UPDATE aim_tenant
          SET onboarding = onboarding || jsonb_build_object(CAST(:flag AS text), to_jsonb(now())), updated_at = now()
        WHERE id = :tenantId AND NOT jsonb_exists(onboarding, :flag)`,
      { replacements: { tenantId, flag }, transaction: t }
    )
  );
}

module.exports = {
  signup,
  verifyEmail,
  resendVerification,
  forgotPassword,
  resetPassword,
  getAccount,
  markOnboardingStep,
  setRoutine,
  parseToken,
  RESERVED_SLUGS,
  ONBOARDING_STEPS,
  MARKABLE_STEPS,
};
