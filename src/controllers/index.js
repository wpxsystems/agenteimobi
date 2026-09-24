'use strict';

// Controllers finos: validam (Zod), chamam o service, serializam e respondem { success, data }.
const env = require('../config/env');
const logger = require('../config/logger');
const schemas = require('../schemas');
const serialize = require('../serializers');
const authService = require('../services/auth.service');
const propertyService = require('../services/property.service');
const leadService = require('../services/lead.service');
const metricsService = require('../services/metrics.service');
const conversation = require('../services/conversation.service');
const { isValidSignature } = require('../services/whatsapp/signature');
const { parseWebhook } = require('../services/whatsapp/webhookParser');

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// ---------------- Auth ----------------
const auth = {
  async login(req, res) {
    const body = schemas.login.parse(req.body);
    const { user, accessToken, refreshToken } = await authService.login(body);
    ok(res, { user: serialize.user(user), accessToken, refreshToken });
  },
  async refresh(req, res) {
    const { refreshToken } = schemas.refresh.parse(req.body);
    ok(res, await authService.refresh(refreshToken));
  },
  async logout(req, res) {
    const { refreshToken } = schemas.refresh.parse(req.body);
    await authService.logout(refreshToken);
    ok(res, null);
  },
};

// ---------------- Imóveis ----------------
const properties = {
  async list(req, res) {
    const rows = await propertyService.list(req.auth.tenantId);
    ok(res, rows.map(serialize.property));
  },
  async get(req, res) {
    const { id } = schemas.idParam.parse(req.params);
    ok(res, serialize.property(await propertyService.get(req.auth.tenantId, id)));
  },
  async create(req, res) {
    const data = schemas.propertyCreate.parse(req.body);
    ok(res, serialize.property(await propertyService.create(req.auth.tenantId, data)), 201);
  },
  async update(req, res) {
    const { id } = schemas.idParam.parse(req.params);
    const data = schemas.propertyUpdate.parse(req.body);
    ok(res, serialize.property(await propertyService.update(req.auth.tenantId, id, data)));
  },
  async links(req, res) {
    const { id } = schemas.idParam.parse(req.params);
    const { src } = schemas.linkQuery.parse(req.query);
    ok(res, await propertyService.links(req.auth.tenantId, id, src));
  },
};

// ---------------- Leads ----------------
const leads = {
  async list(req, res) {
    const query = schemas.leadList.parse(req.query);
    const { rows, count } = await leadService.list(req.auth.tenantId, query);
    ok(res, { items: rows.map(serialize.lead), total: count, limit: query.limit, offset: query.offset });
  },
  async get(req, res) {
    const { id } = schemas.idParam.parse(req.params);
    const { lead, messages } = await leadService.get(req.auth.tenantId, id);
    ok(res, { ...serialize.lead(lead), messages: messages.map(serialize.message) });
  },
  async update(req, res) {
    const { id } = schemas.idParam.parse(req.params);
    const data = schemas.leadUpdate.parse(req.body);
    await leadService.update(req.auth.tenantId, id, data);
    const { lead } = await leadService.get(req.auth.tenantId, id);
    ok(res, serialize.lead(lead));
  },
  async sendMessage(req, res) {
    const { id } = schemas.idParam.parse(req.params);
    const { text } = schemas.humanMessage.parse(req.body);
    await leadService.sendMessage(req.auth.tenantId, id, text);
    ok(res, null, 202);
  },
};

// ---------------- Métricas ----------------
const metrics = {
  async funnel(req, res) {
    const query = schemas.funnelQuery.parse(req.query);
    ok(res, await metricsService.funnel(req.auth.tenantId, query));
  },
};

// ---------------- Webhook WhatsApp (público, autenticado por assinatura) ----------------
const webhook = {
  verify(req, res) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === env.WA_VERIFY_TOKEN && typeof challenge === 'string') {
      return res.status(200).type('text/plain').send(challenge);
    }
    return res.sendStatus(403);
  },
  receive(req, res) {
    if (!isValidSignature(req.body, req.get('x-hub-signature-256'), env.WA_APP_SECRET)) {
      return res.sendStatus(401);
    }
    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.sendStatus(400);
    }
    // Responde 200 na hora (a Meta reenvia se demorar) e processa em seguida.
    res.sendStatus(200);

    const messages = parseWebhook(payload);
    (async () => {
      for (const msg of messages) {
        try {
          await conversation.handleInbound(msg);
        } catch (err) {
          logger.error({ code: err.code, message: err.message }, 'Falha ao processar mensagem do webhook');
        }
      }
    })();
    return undefined;
  },
};

// ---------------- Link rastreado (público) ----------------
const redirect = {
  async go(req, res) {
    const params = schemas.redirectParams.safeParse(req.params);
    const src = schemas.linkQuery.safeParse(req.query);
    if (!params.success) return res.status(404).type('text/plain').send('Link inválido');
    const target = await propertyService.registerClick(params.data.slug, params.data.code, src.success ? src.data.src : undefined);
    if (!target) return res.status(404).type('text/plain').send('Imóvel não disponível');
    return res.redirect(302, target);
  },
};

module.exports = { auth, properties, leads, metrics, webhook, redirect };
