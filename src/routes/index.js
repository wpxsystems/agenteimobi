'use strict';

const express = require('express');
const env = require('../config/env');
const c = require('../controllers');
const { asyncHandler: h, requireAuth, requireRole, rateLimits } = require('../middlewares');

// ---- API autenticada: /api/v1 ----
const api = express.Router();
api.use(rateLimits.api);

api.post('/auth/login', rateLimits.login, h(c.auth.login));
api.post('/auth/refresh', rateLimits.login, h(c.auth.refresh));
api.post('/auth/logout', h(c.auth.logout));

// Cadastro sozinho e links de uso único (públicos, com limite por IP).
api.get('/public-config', c.account.publicConfig);
api.post('/signup', rateLimits.signup, h(c.account.signup));
api.post('/auth/verify-email', rateLimits.oneTimeLink, h(c.account.verifyEmail));
api.post('/auth/forgot-password', rateLimits.passwordReset, h(c.account.forgotPassword));
api.post('/auth/reset-password', rateLimits.oneTimeLink, h(c.account.resetPassword));

// Só fora de produção e com DEV_AUTO_LOGIN=true: o painel local entra sem senha.
if (env.isDev) api.post('/dev/login', rateLimits.login, h(c.dev.login));
// Só fora de produção: e-mails que não saíram (EMAIL_PROVIDER=log).
if (env.isDev) api.get('/dev/outbox', h(c.dev.outbox));

api.use(requireAuth);

api.get('/account', h(c.account.get));
api.post('/account/resend-verification', rateLimits.passwordReset, h(c.account.resendVerification));
api.post('/account/onboarding', h(c.account.onboarding));
api.patch('/account/privacy', requireRole('admin'), h(c.privacy.setRetention));
api.delete('/account', requireRole('admin'), rateLimits.passwordReset, h(c.privacy.deleteAccount));

// Rotina do dono (fase 2)
api.get('/today', h(c.routine.today));
api.patch('/alerts/:id', h(c.routine.resolveAlert));
api.get('/visits', h(c.routine.listVisits));
api.get('/visits/slots', h(c.routine.slots));
api.post('/visits', h(c.routine.createVisit));
api.patch('/visits/:id', h(c.routine.updateVisit));
api.patch('/account/routine', requireRole('admin'), h(c.routine.setRoutine));
api.patch('/account/visit-schedule', requireRole('admin'), h(c.routine.setVisitSchedule));

api.get('/whatsapp', h(c.whatsapp.status));
api.post('/whatsapp/connect', requireRole('admin'), rateLimits.passwordReset, h(c.whatsapp.connect));
api.post('/whatsapp/disconnect', requireRole('admin'), h(c.whatsapp.disconnect));

api.get('/billing', h(c.billing.overview));
api.post('/billing/checkout', requireRole('admin'), rateLimits.passwordReset, h(c.billing.checkout));
// Só fora de produção: simula o aviso do provedor de cobrança (BILLING_PROVIDER=mock).
if (env.isDev) api.post('/dev/billing/simulate', requireRole('admin'), h(c.billing.simulate));

api.get('/properties', h(c.properties.list));
api.get('/properties/:id', h(c.properties.get));
api.post('/properties', requireRole('admin'), h(c.properties.create));
api.patch('/properties/:id', requireRole('admin'), h(c.properties.update));
api.get('/properties/:id/links', h(c.properties.links));
api.get('/properties/:id/open-questions', h(c.properties.openQuestions));

api.get('/leads', h(c.leads.list));
api.get('/leads/export', h(c.leads.export)); // antes de /leads/:id: "export" não é um id
api.get('/leads/:id', h(c.leads.get));
// LGPD: cópia dos dados e exclusão a pedido do titular (só admin).
api.get('/leads/:id/privacy-export', requireRole('admin'), h(c.privacy.exportLead));
api.delete('/leads/:id', requireRole('admin'), h(c.privacy.anonymizeLead));
api.patch('/leads/:id', h(c.leads.update));
api.post('/leads/:id/messages', h(c.leads.sendMessage));

api.get('/metrics/funnel', h(c.metrics.funnel));
api.get('/metrics/overview', h(c.metrics.overview));

// ---- Só fora de produção: simulador de WhatsApp do painel ----
if (env.isDev) {
  api.get('/dev/status', h(c.dev.status));
  api.post('/dev/inbound', h(c.dev.inbound));
}

// ---- Webhook: corpo BRUTO para validar a assinatura ----
const webhooks = express.Router();
webhooks.get('/whatsapp', rateLimits.webhook, c.webhook.verify);
webhooks.post('/whatsapp', rateLimits.webhook, express.raw({ type: 'application/json', limit: '1mb' }), c.webhook.receive);
// Avisos do Asaas: autenticados pelo header asaas-access-token e conferidos na API do Asaas.
webhooks.post('/billing/asaas', rateLimits.webhook, express.json({ limit: '200kb' }), h(c.billing.asaasWebhook));

// ---- Link rastreado público ----
const publicLinks = express.Router();
publicLinks.get('/:slug/:code', rateLimits.redirect, h(c.redirect.go));

module.exports = { api, webhooks, publicLinks };
