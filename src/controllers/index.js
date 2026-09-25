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
const accountService = require('../services/account.service');
const emailService = require('../services/email.service');
const billingService = require('../services/billing.service');
const privacyService = require('../services/privacy.service');
const whatsappService = require('../services/whatsappConnection.service');
const digestService = require('../services/digest.service');
const qualityService = require('../services/quality.service');
const visitService = require('../services/visit.service');
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

// ---------------- Conta: cadastro, links de uso único, primeiros passos ----------------
const account = {
  /** Público: o que o painel mostra antes do login (criar conta aberto ou fechado). */
  publicConfig(_req, res) {
    ok(res, { signupEnabled: env.signupEnabled, billingEnabled: env.billingEnabled });
  },
  async signup(req, res) {
    // Cadastro fechado (modo piloto) responde igual para qualquer corpo.
    if (!env.signupEnabled) throw new AppError('SIGNUP_CLOSED', 'O cadastro está fechado no momento', 403);
    const body = schemas.signup.parse(req.body);
    const { user, accessToken, refreshToken } = await accountService.signup(body);
    ok(res, { user: serialize.user(user), accessToken, refreshToken }, 201);
  },
  async verifyEmail(req, res) {
    const { token } = schemas.verifyEmail.parse(req.body);
    await accountService.verifyEmail(token);
    ok(res, { emailVerified: true });
  },
  /** Sempre 202: a resposta não revela se a conta ou o e-mail existem. */
  async forgotPassword(req, res) {
    const body = schemas.forgotPassword.parse(req.body);
    await accountService.forgotPassword(body);
    ok(res, null, 202);
  },
  async resetPassword(req, res) {
    const body = schemas.resetPassword.parse(req.body);
    await accountService.resetPassword(body);
    ok(res, { passwordReset: true });
  },
  async get(req, res) {
    ok(res, serialize.account(await accountService.getAccount(req.auth.tenantId, req.auth.userId)));
  },
  async resendVerification(req, res) {
    const out = await accountService.resendVerification(req.auth.tenantId, req.auth.userId);
    ok(res, out, 202);
  },
  async onboarding(req, res) {
    const { step } = schemas.onboardingStep.parse(req.body);
    await accountService.markOnboardingStep(req.auth.tenantId, step);
    ok(res, serialize.account(await accountService.getAccount(req.auth.tenantId, req.auth.userId)));
  },
};

// ---------------- Privacidade (LGPD): direitos do titular, retenção, exclusão da conta ----------------
const privacy = {
  /** Cópia dos dados de um lead em JSON (arquivo para baixar e entregar ao titular). */
  async exportLead(req, res) {
    const { id } = schemas.idParam.parse(req.params);
    const data = await privacyService.exportLead(req.auth.tenantId, id, req.auth.userId);
    res.setHeader('content-disposition', `attachment; filename="dados-do-lead-${new Date().toISOString().slice(0, 10)}.json"`);
    res.setHeader('cache-control', 'no-store');
    ok(res, data);
  },
  async anonymizeLead(req, res) {
    const { id } = schemas.idParam.parse(req.params);
    await privacyService.anonymizeLead(req.auth.tenantId, id, req.auth.userId);
    ok(res, { anonymized: true });
  },
  async setRetention(req, res) {
    const { retentionMonths } = schemas.retention.parse(req.body);
    await privacyService.setRetention(req.auth.tenantId, retentionMonths);
    ok(res, serialize.account(await accountService.getAccount(req.auth.tenantId, req.auth.userId)));
  },
  async deleteAccount(req, res) {
    const body = schemas.deleteAccount.parse(req.body);
    await privacyService.deleteAccount(req.auth.tenantId, req.auth.userId, body);
    ok(res, { deleted: true });
  },
};

// ---------------- Rotina do dono: hoje, avisos, visitas, configurações ----------------
const routine = {
  /** Tela "Hoje": números do dia e avisos abertos. */
  async today(req, res) {
    // Recalcula os avisos na hora: o que o corretor acabou de resolver já some da tela.
    await qualityService.syncTenant(req.auth.tenantId);
    const [resumo, avisos] = await Promise.all([digestService.today(req.auth.tenantId), qualityService.listOpen(req.auth.tenantId)]);
    ok(res, { resumo, avisos: avisos.map(serialize.alert) });
  },
  async resolveAlert(req, res) {
    const { id } = schemas.idParam.parse(req.params);
    await qualityService.resolve(req.auth.tenantId, id);
    ok(res, { resolved: true });
  },
  async listVisits(req, res) {
    const q = schemas.visitList.parse(req.query);
    const { timezone, visits } = await visitService.list(req.auth.tenantId, q);
    ok(res, { timezone, visits: visits.map(serialize.visit) });
  },
  async slots(req, res) {
    ok(res, await visitService.freeSlotsFor(req.auth.tenantId));
  },
  async createVisit(req, res) {
    const body = schemas.visitCreate.parse(req.body);
    const v = await visitService.create(req.auth.tenantId, body);
    ok(res, { id: v.id, startsAt: new Date(v.startsAt).toISOString(), label: v.label }, 201);
  },
  async updateVisit(req, res) {
    const { id } = schemas.idParam.parse(req.params);
    const body = schemas.visitUpdate.parse(req.body);
    ok(res, await visitService.update(req.auth.tenantId, id, body));
  },
  async setRoutine(req, res) {
    const body = schemas.routine.parse(req.body);
    await accountService.setRoutine(req.auth.tenantId, body);
    ok(res, serialize.account(await accountService.getAccount(req.auth.tenantId, req.auth.userId)));
  },
  async setVisitSchedule(req, res) {
    const body = schemas.visitSchedule.parse(req.body);
    await visitService.setSchedule(req.auth.tenantId, body);
    ok(res, serialize.account(await accountService.getAccount(req.auth.tenantId, req.auth.userId)));
  },
};

// ---------------- Conexão do WhatsApp pelo painel ----------------
const whatsapp = {
  async status(req, res) {
    ok(res, await whatsappService.status(req.auth.tenantId));
  },
  async connect(req, res) {
    const body = schemas.whatsappConnect.parse(req.body);
    await whatsappService.connect(req.auth.tenantId, req.auth.userId, body);
    ok(res, serialize.account(await accountService.getAccount(req.auth.tenantId, req.auth.userId)));
  },
  async disconnect(req, res) {
    await whatsappService.disconnect(req.auth.tenantId);
    ok(res, serialize.account(await accountService.getAccount(req.auth.tenantId, req.auth.userId)));
  },
};

// ---------------- Plano, uso e cobrança ----------------
const billing = {
  async overview(req, res) {
    ok(res, await billingService.overview(req.auth.tenantId));
  },
  async checkout(req, res) {
    const body = schemas.checkout.parse(req.body);
    ok(res, await billingService.startCheckout(req.auth.tenantId, req.auth.userId, body));
  },
  /** Aviso do Asaas (público, autenticado pelo token do header). */
  async asaasWebhook(req, res) {
    const { status, result } = await billingService.handleAsaasWebhook(req.get('asaas-access-token'), req.body);
    res.status(status).json({ success: status < 400, data: { result } });
  },
  /** Só fora de produção, com BILLING_PROVIDER=mock. */
  async simulate(req, res) {
    const { kind } = schemas.billingSimulate.parse(req.body);
    ok(res, { result: await billingService.simulateEvent(req.auth.tenantId, kind) });
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
  async receive(req, res) {
    if (!isValidSignature(req.body, req.get('x-hub-signature-256'), env.WA_APP_SECRET)) {
      return res.sendStatus(401);
    }
    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.sendStatus(400);
    }
    // Grava as mensagens na fila e só então responde 200: se o banco falhar, o 500 faz a Meta reenviar.
    // O processamento (IA, envio) roda no worker, fora da requisição.
    try {
      await conversation.acceptInbound(parseWebhook(payload));
    } catch (err) {
      logger.error({ code: err.code }, 'Falha ao enfileirar mensagens do webhook');
      return res.sendStatus(500);
    }
    return res.sendStatus(200);
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
    // Com WA_MOCK nada sai para a Meta: conta recém-criada, ainda sem número, também pode testar.
    if (!tenant?.waPhoneNumberId && !env.waMock) {
      throw new AppError('WA_NOT_CONFIGURED', 'Conecte o WhatsApp da conta ou ligue WA_MOCK=true para simular', 409);
    }
    // Mesmo formato normalizado que o webhook produz: passa pela fila e pelo fluxo real de atendimento.
    await conversation.acceptSimulated(tenant.id, {
      phoneNumberId: tenant.waPhoneNumberId || null,
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
  /** Caixa de saída local: e-mails que não saíram (EMAIL_PROVIDER=log). Sem login: serve às telas de cadastro e senha. */
  outbox(_req, res) {
    ok(res, emailService.devOutbox());
  },
};

module.exports = { auth, account, billing, privacy, whatsapp, routine, properties, leads, metrics, webhook, redirect, dev };
