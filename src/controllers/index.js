'use strict';

// Controllers finos: validam (Zod), chamam o service, serializam e respondem { success, data }.
const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../config/logger');
const AppError = require('../errors/AppError');
const { Tenant } = require('../models');
const schemas = require('../schemas');
const serialize = require('../serializers');
const authService = require('../services/auth.service');
const propertyService = require('../services/property.service');
const leadService = require('../services/lead.service');
const metricsService = require('../services/metrics.service');
const exportService = require('../services/export.service');
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
  async openQuestions(req, res) {
    const { id } = schemas.idParam.parse(req.params);
    const rows = await propertyService.openQuestions(req.auth.tenantId, id);
    ok(res, rows.map(serialize.openQuestion));
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
  /** Arquivo (CSV ou Excel) com os leads dos mesmos filtros do funil. Resposta binária, não { success, data }. */
  async export(req, res) {
    const { format, ...filters } = schemas.leadExport.parse(req.query);
    const leads = await leadService.listForExport(req.auth.tenantId, filters);
    const rows = leads.map((l) => exportService.leadRow(serialize.lead(l)));
    const nome = `leads-${new Date().toISOString().slice(0, 10)}`;
    if (format === 'xlsx') {
      const funil = await metricsService.funnel(req.auth.tenantId, filters);
      const imovel = filters.propertyId ? await propertyService.get(req.auth.tenantId, filters.propertyId) : null;
      const fmt = (iso) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('content-disposition', `attachment; filename="${nome}.xlsx"`);
      await exportService.writeXlsx(
        {
          rows,
          resumo: {
            funnel: funil,
            periodo: filters.from || filters.to ? `${filters.from ? fmt(filters.from) : 'início'} a ${filters.to ? fmt(filters.to) : 'hoje'}` : 'Todo o período',
            imovel: imovel ? `${imovel.code} · ${imovel.title}` : 'Todos os imóveis',
          },
        },
        res
      );
      return res.end();
    }
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${nome}.csv"`);
    return res.send(exportService.toCsv(rows));
  },
};

// ---------------- Métricas ----------------
const metrics = {
  async funnel(req, res) {
    const query = schemas.funnelQuery.parse(req.query);
    ok(res, await metricsService.funnel(req.auth.tenantId, query));
  },
  async overview(req, res) {
    const query = schemas.funnelQuery.parse(req.query);
    const data = await metricsService.overview(req.auth.tenantId, query);
    ok(res, { ...data, awaiting: data.awaiting.map(serialize.awaitingLead) });
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

// ---------------- Dev: simulador de WhatsApp (rotas montadas só fora de produção) ----------------
const dev = {
  /** Entrada automática local (DEV_AUTO_LOGIN=true): mesma resposta do login normal. */
  async login(_req, res) {
    const { user, accessToken, refreshToken } = await authService.devLogin();
    ok(res, { user: serialize.user(user), accessToken, refreshToken });
  },
  async status(req, res) {
    const tenant = await Tenant.findByPk(req.auth.tenantId);
    ok(res, {
      waMock: env.waMock,
      aiConfigured: !/^PREENCHER/i.test(env.ANTHROPIC_API_KEY),
      model: env.ANTHROPIC_MODEL,
      debounceMs: env.REPLY_DEBOUNCE_MS,
      tenant: tenant
        ? { slug: tenant.slug, name: tenant.name, assistantName: tenant.assistantName, waConfigured: Boolean(tenant.waPhoneNumberId) }
        : null,
    });
  },
  async inbound(req, res) {
    const { phone, name, text } = schemas.devInbound.parse(req.body);
    const tenant = await Tenant.findByPk(req.auth.tenantId);
    if (!tenant?.waPhoneNumberId) {
      throw new AppError('WA_NOT_CONFIGURED', 'Número de WhatsApp da conta não configurado (seed)', 409);
    }
    // Mesmo formato normalizado que o webhook produz: passa pelo fluxo real de atendimento.
    await conversation.handleInbound({
      phoneNumberId: tenant.waPhoneNumberId,
      waMessageId: `sim-${crypto.randomUUID()}`,
      waId: phone,
      name: name || null,
      type: 'text',
      text,
      timestamp: new Date(),
      referralSource: null,
    });
    ok(res, null, 202);
  },
};

module.exports = { auth, properties, leads, metrics, webhook, redirect, dev };
