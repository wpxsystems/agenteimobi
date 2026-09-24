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

// Só fora de produção e com DEV_AUTO_LOGIN=true: o painel local entra sem senha.
if (env.isDev) api.post('/dev/login', rateLimits.login, h(c.dev.login));

api.use(requireAuth);

api.get('/properties', h(c.properties.list));
api.get('/properties/:id', h(c.properties.get));
api.post('/properties', requireRole('admin'), h(c.properties.create));
api.patch('/properties/:id', requireRole('admin'), h(c.properties.update));
api.get('/properties/:id/links', h(c.properties.links));
api.get('/properties/:id/open-questions', h(c.properties.openQuestions));

api.get('/leads', h(c.leads.list));
api.get('/leads/export', h(c.leads.export)); // antes de /leads/:id: "export" não é um id
api.get('/leads/:id', h(c.leads.get));
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

// ---- Link rastreado público ----
const publicLinks = express.Router();
publicLinks.get('/:slug/:code', rateLimits.redirect, h(c.redirect.go));

module.exports = { api, webhooks, publicLinks };
