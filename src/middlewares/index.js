'use strict';

const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { ZodError } = require('zod');
const env = require('../config/env');
const logger = require('../config/logger');
const AppError = require('../errors/AppError');

/** Encaminha erros de handlers async para o errorHandler. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Autenticação via JWT de acesso. tenantId/userId SEMPRE daqui, nunca do body. */
function requireAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(AppError.unauthorized());
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
    if (payload.typ !== 'access') throw new Error('tipo de token inválido');
    req.auth = { userId: payload.sub, tenantId: payload.tid, role: payload.role };
    return next();
  } catch {
    return next(AppError.unauthorized('Token inválido ou expirado'));
  }
}

const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.auth?.role) ? next() : next(AppError.forbidden());

// Nos testes automatizados, dezenas de logins/cadastros saem do mesmo IP em segundos.
const LIMIT_SCALE = env.NODE_ENV === 'test' ? 100 : 1;

const limiter = (windowMs, max) =>
  rateLimit({
    windowMs,
    max: max * LIMIT_SCALE,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Muitas requisições, tente mais tarde' } }),
  });

const rateLimits = {
  login: limiter(15 * 60 * 1000, 10),
  signup: limiter(60 * 60 * 1000, 10),
  passwordReset: limiter(15 * 60 * 1000, 10),
  oneTimeLink: limiter(15 * 60 * 1000, 20),
  api: limiter(60 * 1000, 120),
  webhook: limiter(60 * 1000, 600),
  redirect: limiter(60 * 1000, 60),
};

function notFound(_req, res) {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Rota não encontrada' } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    err = AppError.validation(err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  if (err instanceof AppError) {
    if (err.status >= 500) logger.error({ code: err.code, path: req.path }, err.message);
    return res.status(err.status).json({
      success: false,
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: { code: 'BAD_JSON', message: 'JSON inválido' } });
  }
  // Nunca vazar stack/SQL para o cliente.
  logger.error({ name: err?.name, message: err?.message, path: req.path }, 'Erro não tratado');
  return res.status(500).json({ success: false, error: { code: 'INTERNAL', message: 'Erro interno' } });
}

module.exports = { asyncHandler, requireAuth, requireRole, rateLimits, notFound, errorHandler };
