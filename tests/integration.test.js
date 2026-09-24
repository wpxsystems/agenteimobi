'use strict';

/**
 * Teste ponta a ponta contra um Postgres DE TESTE (nunca produção).
 * Roda só com TEST_DB=1, após `npm run migrate` e `npm run seed:dev` no banco de teste.
 * WhatsApp e Anthropic são MOCKADOS: nenhuma mensagem real é enviada.
 */

const crypto = require('crypto');

jest.mock('../src/services/whatsapp/client', () => {
  let n = 0;
  return {
    sendText: jest.fn(async () => `wamid.out.${++n}`),
    sendTemplate: jest.fn(async () => `wamid.tpl.${++n}`),
  };
});
jest.mock('../src/services/ai/claude.client', () => ({
  ...jest.requireActual('../src/services/ai/claude.client'),
  runTurn: jest.fn(),
}));

const run = process.env.TEST_DB === '1' ? describe : describe.skip;

run('fluxo WhatsApp -> IA -> classificação (integração)', () => {
  const request = require('supertest');
  const { Sequelize } = require('sequelize');
  const app = require('../src/app');
  const wa = require('../src/services/whatsapp/client');
  const ai = require('../src/services/ai/claude.client');
  const { sequelize } = require('../src/models');

  const owner = new Sequelize(process.env.DATABASE_MIGRATION_URL, { logging: false });
  const PHONE_ID = process.env.SEED_WA_PHONE_NUMBER_ID;
  const LEAD = '5511988887777';
  let seq = 0;

  const sign = (buf) => 'sha256=' + crypto.createHmac('sha256', process.env.WA_APP_SECRET).update(buf).digest('hex');
  const payload = (from, text, id = `wamid.in.${++seq}`) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: PHONE_ID },
              contacts: [{ wa_id: from, profile: { name: 'Maria Teste' } }],
              messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  });
  const post = (p) => {
    const raw = JSON.stringify(p); // string: o supertest envia como está (Buffer seria re-serializado)
    return request(app)
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sign(Buffer.from(raw, 'utf8')))
      .send(raw);
  };
  const waitFor = async (fn, ms = 4000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error('timeout esperando condição');
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const leadRow = async (waId) =>
    (await owner.query(`SELECT * FROM aim_lead WHERE wa_id = :waId`, { replacements: { waId }, type: 'SELECT' }))[0];

  let token;

  beforeAll(async () => {
    await owner.query('TRUNCATE aim_message, aim_lead, aim_link_click, aim_refresh_token CASCADE');
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ tenant: process.env.SEED_TENANT_SLUG, email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    token = res.body.data.accessToken;
  });

  afterAll(async () => {
    await owner.close();
    await sequelize.close();
  });

  test('verificação do webhook', async () => {
    const ok = await request(app).get('/webhooks/whatsapp').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': process.env.WA_VERIFY_TOKEN,
      'hub.challenge': '12345',
    });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('12345');
    const bad = await request(app).get('/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'errado', 'hub.challenge': '1' });
    expect(bad.status).toBe(403);
  });

  test('assinatura inválida = 401 e nada é gravado', async () => {
    const res = await request(app)
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', 'sha256=' + '0'.repeat(64))
      .send(JSON.stringify(payload(LEAD, 'oi')));
    expect(res.status).toBe(401);
    expect(await leadRow(LEAD)).toBeUndefined();
  });

  test('clique no link rastreado conta e redireciona para wa.me', async () => {
    const res = await request(app).get(`/r/${process.env.SEED_TENANT_SLUG}/casa01?src=marketplace`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/wa\.me\/\d+\?text=.*%23CASA01/);
    expect((await request(app).get(`/r/${process.env.SEED_TENANT_SLUG}/NAOEXISTE`)).status).toBe(404);
  });

  test('lead qualificado vira quente e é transferido', async () => {
    ai.runTurn.mockResolvedValueOnce({
      reply: 'Que ótimo! Um corretor vai te chamar para confirmar a visita no sábado de manhã.',
      facts: { monthlyIncomeCents: 800000, guarantee: 'caucao', occupants: 2, hasPets: false, moveInDays: 20, wantsVisit: true },
      propertyCode: null,
      visitPreference: 'sábado de manhã',
      nextAction: 'propor_visita',
      handoffReason: null,
    });

    const first = payload(LEAD, 'Olá! Tenho interesse no imóvel #CASA01 (Casa).');
    expect((await post(first)).status).toBe(200);
    // Reenvio idêntico da Meta (mesmo wamid) não pode duplicar
    expect((await post(first)).status).toBe(200);

    const lead = await waitFor(async () => {
      const l = await leadRow(LEAD);
      return l && l.status === 'transferido' ? l : null;
    });

    expect(lead.classification).toBe('quente');
    expect(lead.score).toBe(100);
    expect(lead.bot_active).toBe(false);
    expect(lead.property_id).not.toBeNull();
    expect(lead.visit_preference).toBe('sábado de manhã');
    expect(lead.privacy_notice_sent_at).not.toBeNull();

    // O status muda antes do envio terminar: espera a mensagem de saída ser gravada.
    const msgs = await waitFor(async () => {
      const rows = await owner.query(`SELECT direction, author FROM aim_message WHERE lead_id = :id ORDER BY created_at`, {
        replacements: { id: lead.id },
        type: 'SELECT',
      });
      return rows.length >= 2 ? rows : null;
    });
    expect(msgs).toEqual([
      { direction: 'in', author: 'lead' },
      { direction: 'out', author: 'bot' },
    ]);

    expect(ai.runTurn).toHaveBeenCalledTimes(1);
    const [phoneId, to, body] = wa.sendText.mock.calls.at(-1);
    expect(phoneId).toBe(PHONE_ID);
    expect(to).toBe(LEAD);
    expect(body).toContain('responda SAIR');
  });

  test('depois de transferido o bot não responde mais', async () => {
    ai.runTurn.mockClear();
    await post(payload(LEAD, 'Alguma novidade?'));
    await new Promise((r) => setTimeout(r, 400));
    expect(ai.runTurn).not.toHaveBeenCalled();
  });

  test('mensagens em sequência geram UMA resposta (debounce)', async () => {
    const other = '5521977776666';
    ai.runTurn.mockClear();
    ai.runTurn.mockResolvedValue({
      reply: 'Oi! Qual a sua renda mensal aproximada?',
      facts: { monthlyIncomeCents: null, guarantee: null, occupants: null, hasPets: null, moveInDays: null, wantsVisit: null },
      propertyCode: 'CASA01',
      visitPreference: null,
      nextAction: 'continuar',
      handoffReason: null,
    });
    await post(payload(other, 'oi'));
    await post(payload(other, 'vi a casa'));
    await post(payload(other, 'ainda está disponível?'));
    await waitFor(async () => ai.runTurn.mock.calls.length === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(ai.runTurn).toHaveBeenCalledTimes(1);
    const history = ai.runTurn.mock.calls[0][0].history.filter((m) => m.author === 'lead');
    expect(history).toHaveLength(3);

    const l = await leadRow(other);
    expect(l.classification).toBe('indefinido');
    expect(l.status).toBe('em_atendimento');
    expect(l.property_id).not.toBeNull(); // vinculado pelo código devolvido pela IA
  });

  test('SAIR = opt-out e para de responder', async () => {
    const other = '5521977776666';
    ai.runTurn.mockClear();
    await post(payload(other, 'SAIR'));
    const l = await waitFor(async () => {
      const r = await leadRow(other);
      return r.status === 'opt_out' ? r : null;
    });
    expect(l.bot_active).toBe(false);
    await post(payload(other, 'oi de novo'));
    await new Promise((r) => setTimeout(r, 300));
    expect(ai.runTurn).not.toHaveBeenCalled();
  });

  test('falha no envio do WhatsApp desfaz "respondido" e a nova tentativa responde', async () => {
    const other = '5531966665555';
    const conversation = require('../src/services/conversation.service');
    ai.runTurn.mockReset();
    ai.runTurn.mockResolvedValue({
      reply: 'Oi! Quantas pessoas vão morar?',
      facts: { monthlyIncomeCents: null, guarantee: null, occupants: null, hasPets: null, moveInDays: null, wantsVisit: null },
      propertyCode: null,
      visitPreference: null,
      nextAction: 'continuar',
      handoffReason: null,
    });
    wa.sendText.mockRejectedValueOnce(Object.assign(new Error('falha meta'), { code: 'WHATSAPP_SEND_FAILED' }));

    await post(payload(other, 'Olá! Tenho interesse no imóvel #CASA01'));
    await waitFor(async () => ai.runTurn.mock.calls.length === 1);
    await new Promise((r) => setTimeout(r, 200));
    let l = await leadRow(other);
    expect(l.last_replied_inbound_at).toBeNull();
    expect(l.privacy_notice_sent_at).toBeNull();

    // Nova tentativa (o job de recuperação faz isso sozinho após 1 min)
    const [tenant] = await owner.query('SELECT id, wa_phone_number_id AS "waPhoneNumberId", name, assistant_name AS "assistantName" FROM aim_tenant', { type: 'SELECT' });
    await conversation.processReply(tenant, l.id);
    l = await leadRow(other);
    expect(l.last_replied_inbound_at).not.toBeNull();
    expect(l.privacy_notice_sent_at).not.toBeNull();
    expect(wa.sendText.mock.calls.at(-1)[1]).toBe(other);
  });

  test('corretor responde pela API e assume a conversa', async () => {
    const other = '5531966665555';
    const l = await leadRow(other);
    const res = await request(app).post(`/api/v1/leads/${l.id}/messages`).set('authorization', `Bearer ${token}`).send({ text: 'Oi, sou o corretor.' });
    expect(res.status).toBe(202);
    expect((await leadRow(other)).bot_active).toBe(false);
    expect(wa.sendText.mock.calls.at(-1)[2]).toBe('Oi, sou o corretor.');
  });

  test('API: listar leads, funil e bloqueio sem token', async () => {
    expect((await request(app).get('/api/v1/leads')).status).toBe(401);

    const list = await request(app).get('/api/v1/leads?classification=quente').set('authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.data.total).toBe(1);
    expect(list.body.data.items[0]).toMatchObject({ phone: LEAD, classification: 'quente', property: { code: 'CASA01' } });
    expect(list.body.data.items[0]).not.toHaveProperty('tenantId');

    const funnel = await request(app).get('/api/v1/metrics/funnel').set('authorization', `Bearer ${token}`);
    expect(funnel.body.data).toMatchObject({ clicks: 1, leads: 3, quentes: 1, transferidos: 1 });
    expect(funnel.body.data.taxas.cliqueParaConversa).toBe(300); // 3 conversas / 1 clique: nos testes os leads não passam pelo link rastreado
  });

  test('API: corretor não pode enviar tenantId no body', async () => {
    const res = await request(app)
      .post('/api/v1/properties')
      .set('authorization', `Bearer ${token}`)
      .send({ code: 'CASA99', title: 'Casa', priceCents: 1000, tenantId: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(422);
  });

  test('refresh token: rotação e detecção de reuso', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ tenant: process.env.SEED_TENANT_SLUG, email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD });
    const r1 = login.body.data.refreshToken;
    const rot = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: r1 });
    expect(rot.status).toBe(200);
    const r2 = rot.body.data.refreshToken;
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: r1 })).status).toBe(401); // reuso
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: r2 })).status).toBe(401); // revogado em cascata
  });

  test('isolamento multi-tenant: outra conta não vê leads nem imóveis', async () => {
    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash('outra-senha-forte-1', 12);
    await owner.transaction(async (t) => {
      const [tn] = await owner.query(
        `INSERT INTO aim_tenant (slug, name) VALUES ('outra-conta', 'Outra') ON CONFLICT (slug) DO UPDATE SET name = 'Outra' RETURNING id`,
        { type: 'SELECT', transaction: t }
      );
      await owner.query("SELECT set_config('app.tenant_id', :id, true)", { replacements: { id: tn.id }, transaction: t });
      await owner.query(
        `INSERT INTO aim_user (tenant_id, name, email, password_hash, role) VALUES (:id, 'Outro', 'outro@exemplo.com.br', :hash, 'admin')
         ON CONFLICT DO NOTHING`,
        { replacements: { id: tn.id, hash }, transaction: t }
      );
    });
    const login = await request(app).post('/api/v1/auth/login').send({ tenant: 'outra-conta', email: 'outro@exemplo.com.br', password: 'outra-senha-forte-1' });
    expect(login.status).toBe(200);
    const other = login.body.data.accessToken;

    const leads = await request(app).get('/api/v1/leads').set('authorization', `Bearer ${other}`);
    expect(leads.body.data.total).toBe(0);
    const props = await request(app).get('/api/v1/properties').set('authorization', `Bearer ${other}`);
    expect(props.body.data).toEqual([]);

    const mine = await request(app).get('/api/v1/leads').set('authorization', `Bearer ${token}`);
    const leadId = mine.body.data.items[0].id;
    expect((await request(app).get(`/api/v1/leads/${leadId}`).set('authorization', `Bearer ${other}`)).status).toBe(404);
    // Admin da conta A não loga na conta B com a própria senha
    const cross = await request(app)
      .post('/api/v1/auth/login')
      .send({ tenant: 'outra-conta', email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD });
    expect(cross.status).toBe(401);
  });

  test('login com senha errada', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ tenant: process.env.SEED_TENANT_SLUG, email: process.env.SEED_ADMIN_EMAIL, password: 'errada' });
    expect(res.status).toBe(401);
  });
});
