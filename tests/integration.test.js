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
    // Leitura do token da conta: a real (não faz chamada de rede).
    accessTokenFor: jest.requireActual('../src/services/whatsapp/client').accessTokenFor,
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
  const { createWorker } = require('../src/jobs/worker');

  const owner = new Sequelize(process.env.DATABASE_MIGRATION_URL, { logging: false });
  // O processamento sai da requisição e roda na fila: o worker sobe junto com os testes.
  const worker = createWorker({ concurrency: 5, pollMs: 50 });
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
    await owner.query('TRUNCATE aim_digest, aim_privacy_request, aim_billing_event, aim_job, aim_usage_month, aim_message, aim_lead, aim_link_click, aim_refresh_token CASCADE');
    // Conta do seed começa SEM grade de visitas: o fluxo clássico (lead quente com preferência -> corretor).
    // O agendamento pela IA é testado à parte, em "agenda de visitas".
    await owner.query(`UPDATE aim_tenant SET visit_schedule = '{"slotMinutes":60,"days":{}}', digest_enabled = true, handoff_sla_minutes = 120 WHERE slug = :s`, {
      replacements: { s: process.env.SEED_TENANT_SLUG },
    });
    worker.start();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ tenant: process.env.SEED_TENANT_SLUG, email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    token = res.body.data.accessToken;
  });

  afterAll(async () => {
    await worker.stop();
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
      handoffSummary: null, // a IA não transferiu: o backend gera o resumo
      openQuestions: [],
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
    expect(lead.handoff_summary).toContain('#CASA01');
    expect(lead.handoff_summary).toContain('sábado de manhã');

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
    const [tenantArg, to, body] = wa.sendText.mock.calls.at(-1);
    expect(tenantArg.waPhoneNumberId).toBe(PHONE_ID); // o envio recebe a conta (token por conta)
    expect(to).toBe(LEAD);
    expect(body).toContain('responda SAIR');
  });

  test('fila: o webhook grava o job antes do 200 e o job fecha sem guardar o texto', async () => {
    // O job fecha logo depois do envio: espera todos concluírem.
    const jobs = await waitFor(async () => {
      const rows = await owner.query(
        `SELECT kind, status, payload FROM aim_job WHERE kind = 'inbound' AND serial_key = :key ORDER BY created_at`,
        { replacements: { key: `in:${LEAD}` }, type: 'SELECT' }
      );
      const open = await owner.query(`SELECT 1 FROM aim_job WHERE status IN ('pendente', 'executando')`, { type: 'SELECT' });
      return open.length === 0 ? rows : null;
    });
    // Duas entregas do mesmo wamid = dois jobs; o segundo é ignorado pelo registro idempotente.
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    for (const j of jobs) {
      expect(j.status).toBe('feito');
      expect(j.payload).toEqual({});
    }
    const replies = await owner.query(`SELECT status FROM aim_job WHERE kind = 'reply' AND serial_key LIKE 'reply:%'`, { type: 'SELECT' });
    expect(replies.map((r) => r.status)).toEqual(['feito']);
  });

  test('uso do mês: uma conversa e uma chamada à IA para o lead atendido', async () => {
    const [u] = await owner.query('SELECT conversations, ai_calls FROM aim_usage_month', { type: 'SELECT' });
    expect(u).toEqual({ conversations: 1, ai_calls: 1 });
    const l = await leadRow(LEAD);
    expect(l.usage_month).not.toBeNull();
  });

  test('fila: ordem estrita por contato, sem retomar job travado sem tentativas', async () => {
    const jobService = require('../src/services/job.service');
    await worker.stop(); // reivindica à mão, sem o worker competir
    const [tn] = await owner.query('SELECT id FROM aim_tenant WHERE slug = :s', { replacements: { s: process.env.SEED_TENANT_SLUG }, type: 'SELECT' });
    const ins = (key, extra) =>
      owner.query(
        `INSERT INTO aim_job (tenant_id, kind, serial_key, payload, status, run_at, attempts, max_attempts, locked_at, created_at)
         VALUES (:t, 'inbound', :key, '{}', :status, now() + make_interval(secs => :delay), :attempts, 5, :locked, now() + make_interval(secs => :order))
         RETURNING id`,
        { replacements: { t: tn.id, key, status: 'pendente', delay: 0, attempts: 0, locked: null, order: 0, ...extra }, type: 'SELECT' }
      );
    try {
      // Contato A: a 1ª mensagem espera nova tentativa (run_at no futuro); a 2ª já está pronta e NÃO pode passar na frente.
      await ins('in:teste-a', { delay: 60, attempts: 1, order: 0 });
      const [a2] = await ins('in:teste-a', { delay: 0, order: 1 });
      // Contato B: travado há muito tempo, mas já esgotou as tentativas: não é retomado.
      await ins('in:teste-b', { status: 'executando', attempts: 5, locked: new Date(Date.now() - 3600e3) });
      // Contato C: travado com tentativas sobrando: é retomado.
      const [c1] = await ins('in:teste-c', { status: 'executando', attempts: 1, locked: new Date(Date.now() - 3600e3) });

      const claimed = await jobService.claim(10);
      const ids = claimed.map((j) => j.id);
      expect(ids).not.toContain(a2.id);
      expect(ids).toContain(c1.id);
      expect(ids).toHaveLength(1);

      // A limpeza marca o travado sem tentativas como falho.
      await jobService.purge();
      const [b] = await owner.query(`SELECT status, last_error FROM aim_job WHERE serial_key = 'in:teste-b'`, { type: 'SELECT' });
      expect(b).toEqual({ status: 'falhou', last_error: 'TRAVADO_SEM_TENTATIVAS' });
    } finally {
      await owner.query(`DELETE FROM aim_job WHERE serial_key LIKE 'in:teste-%'`);
      worker.start();
    }
  });

  test('banco fora do ar no webhook = 500 (a Meta reenvia)', async () => {
    const conversation = require('../src/services/conversation.service');
    const spy = jest.spyOn(conversation, 'acceptInbound').mockRejectedValueOnce(Object.assign(new Error('db'), { code: 'ECONNREFUSED' }));
    const res = await post(payload('5511900001111', 'oi'));
    expect(res.status).toBe(500);
    spy.mockRestore();
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
      handoffSummary: null,
      openQuestions: ['Tem vaga para moto?'],
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

  test('dúvidas sem resposta ficam no lead e agregadas por imóvel', async () => {
    const l = await leadRow('5521977776666');
    expect(l.open_questions).toEqual(['Tem vaga para moto?']);
    const res = await request(app).get(`/api/v1/properties/${l.property_id}/open-questions`).set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([expect.objectContaining({ question: 'Tem vaga para moto?', leads: 1 })]);
    const lead = await request(app).get(`/api/v1/leads/${l.id}`).set('authorization', `Bearer ${token}`);
    expect(lead.body.data.openQuestions).toEqual(['Tem vaga para moto?']);
  });

  test('lead aceita a alternativa: a IA devolve outro código e o imóvel do lead troca', async () => {
    const other = '5521977776666';
    ai.runTurn.mockReset();
    ai.runTurn.mockResolvedValue({
      reply: 'Combinado, vamos falar da kitnet então.',
      facts: { monthlyIncomeCents: null, guarantee: null, occupants: 1, hasPets: null, moveInDays: null, wantsVisit: null },
      propertyCode: 'KIT01',
      visitPreference: null,
      nextAction: 'continuar',
      handoffReason: null,
      handoffSummary: null,
      openQuestions: [],
    });
    const before = await leadRow(other);
    await post(payload(other, 'Prefiro a kitnet #KIT01 então'));
    const l = await waitFor(async () => {
      const r = await leadRow(other);
      return r.property_id !== before.property_id ? r : null;
    });
    const [p] = await owner.query('SELECT code FROM aim_property WHERE id = :id', { replacements: { id: l.property_id }, type: 'SELECT' });
    expect(p.code).toBe('KIT01');
    expect(l.open_questions).toEqual(['Tem vaga para moto?']); // dúvidas anteriores são mantidas
    // Código inválido/inativo não troca nada
    ai.runTurn.mockResolvedValue({ ...(await ai.runTurn()), propertyCode: 'NAOEXISTE' });
    await post(payload(other, 'e o #NAOEXISTE?'));
    await waitFor(async () => ai.runTurn.mock.calls.length >= 3);
    await new Promise((r) => setTimeout(r, 300));
    expect((await leadRow(other)).property_id).toBe(l.property_id);
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
    const [tenant] = await owner.query(
      'SELECT id, wa_phone_number_id AS "waPhoneNumberId", name, assistant_name AS "assistantName" FROM aim_tenant WHERE slug = :s',
      { replacements: { s: process.env.SEED_TENANT_SLUG }, type: 'SELECT' }
    );
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

    const ov = await request(app).get('/api/v1/metrics/overview').set('authorization', `Bearer ${token}`);
    expect(ov.status).toBe(200);
    expect(ov.body.data.funnel).toMatchObject({ clicks: 1, leads: 3 });
    expect(ov.body.data.timeline.days).toHaveLength(90);
    expect(ov.body.data.timeline.days.at(-1)).toMatchObject({ clicks: 1, leads: 3 });
    expect(ov.body.data.byProperty.find((p) => p.code === 'CASA01')).toMatchObject({ clicks: 1, quentes: 1, transferidos: 1 });
    expect(ov.body.data.bySource.clicks).toEqual([{ source: 'marketplace', n: 1 }]);
    // O lead quente foi transferido e o corretor ainda não respondeu: aparece na fila
    expect(ov.body.data.awaiting.map((a) => a.phone)).toContain(LEAD);
    expect(ov.body.data.awaiting[0]).not.toHaveProperty('tenantId');
    expect(ov.body.data.handoff.count).toBe(1);
    expect(ov.body.data.byProperty.find((p) => p.code === 'CASA01')).toMatchObject({ frios: 0 });
    expect(ov.body.data.messages.totals.lead).toBeGreaterThanOrEqual(5);
    expect(ov.body.data.messages.totals.human).toBe(1);
    expect(ov.body.data.messages.byDay).toHaveLength(90);
    expect(ov.body.data.messages.byDay.at(-1).lead).toBe(ov.body.data.messages.totals.lead);
    expect(ov.body.data.messages).toMatchObject({ leads: 3, botOnly: 2 });
    expect(ov.body.data.openQuestionsTop).toEqual([expect.objectContaining({ question: 'Tem vaga para moto?', propertyCode: 'KIT01', leads: 1 })]);
    const filtered = await request(app).get('/api/v1/metrics/overview?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z').set('authorization', `Bearer ${token}`);
    expect(filtered.body.data.funnel.leads).toBe(0);
    expect(filtered.body.data.timeline.days).toHaveLength(2);
  });

  test('exportação: CSV e Excel com os mesmos filtros do funil', async () => {
    expect((await request(app).get('/api/v1/leads/export?format=xlsx')).status).toBe(401);

    const csv = await request(app).get('/api/v1/leads/export?format=csv').set('authorization', `Bearer ${token}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/leads-\d{4}-\d{2}-\d{2}\.csv/);
    const linhas = csv.text.split('\r\n');
    expect(linhas[0]).toContain('"Nome";"Telefone"');
    expect(linhas).toHaveLength(1 + 3); // cabeçalho + 3 leads
    expect(csv.text).toContain(LEAD);

    const xlsx = await request(app).get('/api/v1/leads/export?format=xlsx').set('authorization', `Bearer ${token}`).buffer().parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);
    expect(xlsx.body.slice(0, 2).toString()).toBe('PK'); // zip = xlsx
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Leads', 'Resumo']);
    expect(wb.getWorksheet('Leads').rowCount).toBe(1 + 3);
    expect(wb.getWorksheet('Leads').getCell('A1').value).toBe('Nome');

    // Filtro de período vazio: só o cabeçalho
    const vazio = await request(app).get('/api/v1/leads/export?format=csv&from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z').set('authorization', `Bearer ${token}`);
    expect(vazio.text.split('\r\n')).toHaveLength(1);
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

  test('entrada automática local emite a sessão do admin do seed', async () => {
    const res = await request(app).post('/api/v1/dev/login');
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ email: process.env.SEED_ADMIN_EMAIL, role: 'admin' });
    expect(res.body.data.user).not.toHaveProperty('passwordHash');
    const me = await request(app).get('/api/v1/properties').set('authorization', `Bearer ${res.body.data.accessToken}`);
    expect(me.status).toBe(200);
    const rot = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: res.body.data.refreshToken });
    expect(rot.status).toBe(200);
  });

  describe('cadastro sozinho', () => {
    const emailService = require('../src/services/email.service');
    const nova = { accountName: 'Imobiliária Nova', slug: 'imob-nova', name: 'Ana Dona', email: 'Ana@Exemplo.com.br', password: 'senha-forte-123', acceptTerms: true };
    const tokenDoLink = (link) => decodeURIComponent(new URL(link).search.split('=')[1]);
    const ultimoLink = (assunto) => emailService.devOutbox().find((m) => m.subject.includes(assunto))?.link;
    let sessao;

    beforeAll(async () => {
      await owner.query(`DELETE FROM aim_tenant WHERE slug IN ('imob-nova')`);
    });

    test('cria conta, admin, aceite e link de confirmação; já entra logado', async () => {
      const res = await request(app).post('/api/v1/signup').send(nova);
      expect(res.status).toBe(201);
      expect(res.body.data.user).toMatchObject({ name: 'Ana Dona', email: 'ana@exemplo.com.br', role: 'admin', emailVerified: false });
      expect(res.body.data.user).not.toHaveProperty('passwordHash');
      sessao = res.body.data;

      const [tn] = await owner.query(`SELECT id, name FROM aim_tenant WHERE slug = 'imob-nova'`, { type: 'SELECT' });
      expect(tn.name).toBe('Imobiliária Nova');
      const consent = await owner.query('SELECT document, version FROM aim_consent WHERE tenant_id = :id ORDER BY document', { replacements: { id: tn.id }, type: 'SELECT' });
      expect(consent.map((c) => c.document)).toEqual(['privacidade', 'termos']);
      const [tok] = await owner.query('SELECT token_hash FROM aim_user_token WHERE tenant_id = :id', { replacements: { id: tn.id }, type: 'SELECT' });
      expect(tok.token_hash).toMatch(/^[0-9a-f]{64}$/); // só o hash fica no banco

      const link = ultimoLink('Confirme');
      expect(link).toMatch(/\/painel\/\?verificar=/);
      expect(tokenDoLink(link)).not.toBe(tok.token_hash);

      const acc = await request(app).get('/api/v1/account').set('authorization', `Bearer ${sessao.accessToken}`);
      expect(acc.status).toBe(200);
      expect(acc.body.data.tenant).toMatchObject({ slug: 'imob-nova', whatsappConnected: false });
      expect(acc.body.data.onboarding.steps).toEqual([
        { key: 'conta', done: true },
        { key: 'email', done: false },
        { key: 'imovel', done: false },
        { key: 'whatsapp', done: false },
        { key: 'link', done: false },
        { key: 'teste', done: false },
      ]);
      expect(acc.body.data.onboarding.completed).toBe(false);
    });

    test('endereço repetido, reservado, sem aceite ou senha curta são recusados', async () => {
      expect((await request(app).post('/api/v1/signup').send(nova)).status).toBe(409);
      expect((await request(app).post('/api/v1/signup').send({ ...nova, slug: 'admin' })).status).toBe(409);
      expect((await request(app).post('/api/v1/signup').send({ ...nova, slug: 'outra-nova', acceptTerms: false })).status).toBe(422);
      expect((await request(app).post('/api/v1/signup').send({ ...nova, slug: 'outra-nova', password: 'curta' })).status).toBe(422);
      expect((await request(app).post('/api/v1/signup').send({ ...nova, slug: 'outra-nova', tenantId: 'x' })).status).toBe(422);
      const [n] = await owner.query(`SELECT count(*)::int AS n FROM aim_tenant WHERE slug = 'outra-nova'`, { type: 'SELECT' });
      expect(n.n).toBe(0);
    });

    test('confirma o e-mail pelo link; o link não vale duas vezes', async () => {
      const token = tokenDoLink(ultimoLink('Confirme'));
      expect((await request(app).post('/api/v1/auth/verify-email').send({ token })).status).toBe(200);
      expect((await request(app).post('/api/v1/auth/verify-email').send({ token })).status).toBe(400);
      const bad = token.slice(0, -4) + 'AAAA';
      expect((await request(app).post('/api/v1/auth/verify-email').send({ token: bad })).status).toBe(400);
      const acc = await request(app).get('/api/v1/account').set('authorization', `Bearer ${sessao.accessToken}`);
      expect(acc.body.data.user.emailVerified).toBe(true);
      expect(acc.body.data.onboarding.steps[1]).toEqual({ key: 'email', done: true });
    });

    test('marca o passo do link; passo desconhecido é recusado', async () => {
      const auth = { authorization: `Bearer ${sessao.accessToken}` };
      const res = await request(app).post('/api/v1/account/onboarding').set(auth).send({ step: 'link' });
      expect(res.status).toBe(200);
      expect(res.body.data.onboarding.steps.find((s) => s.key === 'link').done).toBe(true);
      expect((await request(app).post('/api/v1/account/onboarding').set(auth).send({ step: 'email' })).status).toBe(422);
    });

    test('esqueci a senha: mesma resposta para quem existe e quem não existe', async () => {
      const antes = emailService.devOutbox().length;
      const r1 = await request(app).post('/api/v1/auth/forgot-password').send({ tenant: 'imob-nova', email: 'ninguem@exemplo.com.br' });
      const r2 = await request(app).post('/api/v1/auth/forgot-password').send({ tenant: 'conta-que-nao-existe', email: 'ana@exemplo.com.br' });
      expect([r1.status, r2.status]).toEqual([202, 202]);
      expect(emailService.devOutbox().length).toBe(antes);
      const r3 = await request(app).post('/api/v1/auth/forgot-password').send({ tenant: 'imob-nova', email: 'ANA@exemplo.com.br' });
      expect(r3.status).toBe(202);
      expect(ultimoLink('Redefinir')).toMatch(/\/painel\/\?redefinir=/);
    });

    test('redefine a senha, encerra as sessões e o link não vale duas vezes', async () => {
      const token = tokenDoLink(ultimoLink('Redefinir'));
      expect((await request(app).post('/api/v1/auth/reset-password').send({ token, password: 'nova-senha-456' })).status).toBe(200);
      expect((await request(app).post('/api/v1/auth/reset-password').send({ token, password: 'outra-senha-789' })).status).toBe(400);
      // Sessão antiga não renova mais
      expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: sessao.refreshToken })).status).toBe(401);
      const velha = await request(app).post('/api/v1/auth/login').send({ tenant: 'imob-nova', email: 'ana@exemplo.com.br', password: nova.password });
      expect(velha.status).toBe(401);
      const nova2 = await request(app).post('/api/v1/auth/login').send({ tenant: 'imob-nova', email: 'ana@exemplo.com.br', password: 'nova-senha-456' });
      expect(nova2.status).toBe(200);
    });

    test('RLS: a aplicação não altera nem cria outra conta', async () => {
      const inTx = require('../src/db/inTx');
      const [nova3] = await owner.query(`SELECT id FROM aim_tenant WHERE slug = 'imob-nova'`, { type: 'SELECT' });
      const [seed] = await owner.query('SELECT id, onboarding FROM aim_tenant WHERE slug = :s', { replacements: { s: process.env.SEED_TENANT_SLUG }, type: 'SELECT' });
      // No contexto da conta nova, tentar mexer na conta do seed não afeta nenhuma linha.
      const [, meta] = await inTx(nova3.id, (t) =>
        sequelize.query(`UPDATE aim_tenant SET onboarding = '{"invadido":true}' WHERE id = :id`, { replacements: { id: seed.id }, transaction: t })
      );
      expect(meta.rowCount).toBe(0);
      // Criar conta com id diferente do contexto é barrado pela policy.
      await expect(
        inTx(nova3.id, (t) =>
          sequelize.query(`INSERT INTO aim_tenant (id, slug, name) VALUES (gen_random_uuid(), 'intrusa', 'x')`, { transaction: t })
        )
      ).rejects.toThrow(/row-level security/);
      // Coluna fora da permissão (endereço da conta) não pode ser gravada pela aplicação.
      await expect(
        inTx(nova3.id, (t) =>
          sequelize.query(`UPDATE aim_tenant SET slug = 'trocado' WHERE id = :id`, { replacements: { id: nova3.id }, transaction: t })
        )
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('planos e cobrança', () => {
    const conversation = require('../src/services/conversation.service');
    const env = require('../src/config/env');
    const asaas = require('../src/services/billing/asaas');
    const { PLANS } = require('../src/config/plans');
    let auth;
    let tenantId;
    const sub = async () =>
      (await owner.query('SELECT plan, status, pending_plan, trial_ends_at, grace_until, current_period_end, provider FROM aim_subscription WHERE tenant_id = :id', { replacements: { id: tenantId }, type: 'SELECT' }))[0];
    const setSub = (sql) => owner.query(`UPDATE aim_subscription SET ${sql} WHERE tenant_id = :id`, { replacements: { id: tenantId } });
    const simular = (waId, text) =>
      conversation.acceptSimulated(tenantId, { phoneNumberId: null, waMessageId: `sim-${crypto.randomUUID()}`, waId, name: 'Lead Plano', type: 'text', text, timestamp: new Date(), referralSource: null });

    beforeAll(async () => {
      const login = await request(app).post('/api/v1/auth/login').send({ tenant: 'imob-nova', email: 'ana@exemplo.com.br', password: 'nova-senha-456' });
      expect(login.status).toBe(200);
      auth = { authorization: `Bearer ${login.body.data.accessToken}` };
      [{ id: tenantId }] = await owner.query(`SELECT id FROM aim_tenant WHERE slug = 'imob-nova'`, { type: 'SELECT' });
    });

    test('o cadastro começa com o teste grátis', async () => {
      const s = await sub();
      expect(s).toMatchObject({ plan: 'teste', status: 'teste' });
      const dias = (new Date(s.trial_ends_at) - Date.now()) / 86400e3;
      expect(dias).toBeGreaterThan(13.9);
      expect(dias).toBeLessThanOrEqual(14);
      const res = await request(app).get('/api/v1/billing').set(auth);
      expect(res.status).toBe(200);
      expect(res.body.data.subscription).toMatchObject({ plan: 'teste', active: true, reason: null });
      expect(res.body.data.limits).toEqual(PLANS.teste.limits);
      expect(res.body.data.plans.map((p) => p.key)).toEqual(['essencial', 'profissional']);
    });

    test('teste vencido: lead novo vai para o corretor sem chamar a IA', async () => {
      await setSub("trial_ends_at = now() - interval '1 minute'");
      ai.runTurn.mockClear();
      wa.sendText.mockClear();
      await simular('5511955550001', 'Olá, tenho interesse');
      const l = await waitFor(async () => {
        const r = await leadRow('5511955550001');
        return r && r.status === 'transferido' ? r : null;
      });
      expect(l.bot_active).toBe(false);
      expect(l.handoff_reason).toBe('plano:teste_expirado');
      expect(l.usage_month).toBeNull(); // sem IA, não conta como conversa
      expect(ai.runTurn).not.toHaveBeenCalled();
      await waitFor(async () => wa.sendText.mock.calls.length > 0);
      expect(wa.sendText.mock.calls.at(-1)[2]).toContain('Um corretor vai continuar o seu atendimento');
      expect(wa.sendText.mock.calls.at(-1)[2]).toContain('responda SAIR'); // aviso de privacidade na primeira mensagem
    });

    test('limite do mês: conversa nova para; conversa já contada no mês continua', async () => {
      await setSub("trial_ends_at = now() + interval '7 days'");
      const limite = PLANS.teste.limits.conversations;
      await owner.query(
        `INSERT INTO aim_usage_month (tenant_id, month, conversations) VALUES (:id, date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date, :n)
         ON CONFLICT (tenant_id, month) DO UPDATE SET conversations = :n`,
        { replacements: { id: tenantId, n: limite } }
      );
      ai.runTurn.mockReset();
      ai.runTurn.mockResolvedValue({
        reply: 'Oi! Quantas pessoas vão morar?',
        facts: { monthlyIncomeCents: null, guarantee: null, occupants: null, hasPets: null, moveInDays: null, wantsVisit: null },
        propertyCode: null, visitPreference: null, nextAction: 'continuar', handoffReason: null, handoffSummary: null, openQuestions: [],
      });
      await simular('5511955550002', 'Oi');
      const bloqueado = await waitFor(async () => {
        const r = await leadRow('5511955550002');
        return r && r.status === 'transferido' ? r : null;
      });
      expect(bloqueado.handoff_reason).toBe('plano:limite_de_conversas');
      expect(ai.runTurn).not.toHaveBeenCalled();

      // Lead que já conversou com a IA neste mês: segue sendo atendido mesmo no limite.
      await simular('5511955550003', 'Oi');
      await waitFor(async () => leadRow('5511955550003'));
      await owner.query(
        `UPDATE aim_lead SET usage_month = date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date, status = 'em_atendimento', bot_active = true, handoff_reason = NULL, last_replied_inbound_at = NULL
          WHERE wa_id = '5511955550003'`
      );
      ai.runTurn.mockClear();
      await simular('5511955550003', 'Continuando: somos 2 pessoas');
      await waitFor(async () => ai.runTurn.mock.calls.length === 1);
      const [u] = await owner.query('SELECT conversations FROM aim_usage_month WHERE tenant_id = :id', { replacements: { id: tenantId }, type: 'SELECT' });
      expect(u.conversations).toBe(limite); // não contou de novo
    });

    test('limite de imóveis ativos do plano', async () => {
      const limite = PLANS.teste.limits.properties;
      const [{ n }] = await owner.query('SELECT count(*)::int AS n FROM aim_property WHERE tenant_id = :id AND is_active', { replacements: { id: tenantId }, type: 'SELECT' });
      for (let i = n; i < limite; i += 1) {
        const r = await request(app).post('/api/v1/properties').set(auth).send({ code: `LIM${i}`, title: `Imóvel ${i}`, priceCents: 100000 });
        expect(r.status).toBe(201);
      }
      const extra = await request(app).post('/api/v1/properties').set(auth).send({ code: 'LIMX', title: 'Um a mais', priceCents: 100000 });
      expect(extra.status).toBe(403);
      expect(extra.body.error.code).toBe('PLAN_LIMIT');
      // Inativo não conta; reativar acima do limite é barrado.
      const inativo = await request(app).post('/api/v1/properties').set(auth).send({ code: 'LIMY', title: 'Inativo', priceCents: 100000, isActive: false });
      expect(inativo.status).toBe(201);
      const reativar = await request(app).patch(`/api/v1/properties/${inativo.body.data.id}`).set(auth).send({ isActive: true });
      expect(reativar.status).toBe(403);
    });

    test('checkout: valida plano e CPF/CNPJ; CPF não é gravado', async () => {
      expect((await request(app).post('/api/v1/billing/checkout').set(auth).send({ plan: 'interno', document: '52998224725' })).status).toBe(422);
      expect((await request(app).post('/api/v1/billing/checkout').set(auth).send({ plan: 'essencial', document: '12345678900' })).status).toBe(422);
      const ok = await request(app).post('/api/v1/billing/checkout').set(auth).send({ plan: 'essencial', document: '529.982.247-25' });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toEqual({ checkoutUrl: null, simulated: true });
      expect(await sub()).toMatchObject({ plan: 'teste', status: 'teste', pending_plan: 'essencial', provider: 'mock' });
      const [row] = await owner.query('SELECT row_to_json(s)::text AS t FROM aim_subscription s WHERE tenant_id = :id', { replacements: { id: tenantId }, type: 'SELECT' });
      expect(row.t).not.toContain('52998224725');
    });

    test('pagamento, atraso e cancelamento mudam a assinatura', async () => {
      const simula = (kind) => request(app).post('/api/v1/dev/billing/simulate').set(auth).send({ kind });
      expect((await simula('paid')).body.data.result).toBe('applied');
      let s = await sub();
      expect(s).toMatchObject({ plan: 'essencial', status: 'ativa', pending_plan: null, grace_until: null });
      expect(new Date(s.current_period_end) > new Date(Date.now() + 29 * 86400e3)).toBe(true);

      await simula('overdue');
      s = await sub();
      expect(s.status).toBe('inadimplente');
      const primeiraCarencia = s.grace_until;
      await simula('overdue'); // segundo aviso de atraso não estende a carência
      expect((await sub()).grace_until).toEqual(primeiraCarencia);
      const ov = await request(app).get('/api/v1/billing').set(auth);
      expect(ov.body.data.subscription).toMatchObject({ status: 'inadimplente', active: true, warning: 'pagamento_atrasado' });

      await simula('paid');
      await simula('canceled');
      const ov2 = await request(app).get('/api/v1/billing').set(auth);
      expect(ov2.body.data.subscription).toMatchObject({ status: 'cancelada', active: true, warning: 'assinatura_cancelada' });
    });

    test('aviso do Asaas: token, conferência na API, idempotência e assinatura de outra conta', async () => {
      const original = { provider: env.BILLING_PROVIDER, token: env.ASAAS_WEBHOOK_TOKEN };
      env.BILLING_PROVIDER = 'asaas';
      env.ASAAS_WEBHOOK_TOKEN = 'token-do-webhook-123456';
      await setSub("provider = 'asaas', provider_subscription_id = 'sub_teste_1', status = 'ativa', grace_until = NULL");
      const pay = jest.spyOn(asaas, 'fetchPayment').mockResolvedValue({ id: 'pay_1', status: 'OVERDUE', subscriptionId: 'sub_teste_1', dueDate: '2026-10-01' });
      const st = jest.spyOn(asaas, 'fetchSubscriptionState').mockResolvedValue({ tenantId, subscriptionId: 'sub_teste_1', subscriptionStatus: 'ACTIVE', nextDueDate: '2026-10-01', deleted: false });
      const aviso = (body, token = env.ASAAS_WEBHOOK_TOKEN) =>
        request(app).post('/webhooks/billing/asaas').set('asaas-access-token', token).send(body);
      try {
        expect((await aviso({ id: 'evt_1', event: 'PAYMENT_OVERDUE', payment: { id: 'pay_1' } }, 'token-errado-000000000')).status).toBe(401);
        const r1 = await aviso({ id: 'evt_1', event: 'PAYMENT_OVERDUE', payment: { id: 'pay_1', status: 'RECEIVED' } }); // corpo mente: vale o que a API diz
        expect(r1.body.data.result).toBe('applied');
        expect((await sub()).status).toBe('inadimplente');
        expect((await aviso({ id: 'evt_1', event: 'PAYMENT_OVERDUE', payment: { id: 'pay_1' } })).body.data.result).toBe('duplicate');
        expect((await aviso({ id: 'evt_2', event: 'PAYMENT_CREATED', payment: { id: 'pay_1' } })).body.data.result).toBe('ignored');
        // Assinatura que não é a desta conta: ignorado.
        st.mockResolvedValueOnce({ tenantId, subscriptionId: 'sub_de_outro', subscriptionStatus: 'ACTIVE', nextDueDate: null, deleted: false });
        pay.mockResolvedValueOnce({ id: 'pay_2', status: 'RECEIVED', subscriptionId: 'sub_de_outro', dueDate: null });
        expect((await aviso({ id: 'evt_3', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_2' } })).body.data.result).toBe('ignored');
        expect((await sub()).status).toBe('inadimplente');
      } finally {
        pay.mockRestore();
        st.mockRestore();
        env.BILLING_PROVIDER = original.provider;
        env.ASAAS_WEBHOOK_TOKEN = original.token;
      }
    });

    test('corretor (não admin) não contrata plano', async () => {
      const bcrypt = require('bcrypt');
      await owner.transaction(async (t) => {
        await owner.query("SELECT set_config('app.tenant_id', :id, true)", { replacements: { id: tenantId }, transaction: t });
        await owner.query(
          `INSERT INTO aim_user (tenant_id, name, email, password_hash, role, email_verified_at) VALUES (:id, 'Corretor', 'corretor@exemplo.com.br', :h, 'corretor', now()) ON CONFLICT DO NOTHING`,
          { replacements: { id: tenantId, h: await bcrypt.hash('senha-corretor-1', 12) }, transaction: t }
        );
      });
      const l = await request(app).post('/api/v1/auth/login').send({ tenant: 'imob-nova', email: 'corretor@exemplo.com.br', password: 'senha-corretor-1' });
      const r = await request(app).post('/api/v1/billing/checkout').set('authorization', `Bearer ${l.body.data.accessToken}`).send({ plan: 'essencial', document: '52998224725' });
      expect(r.status).toBe(403);
    });
  });

  describe('LGPD: direitos do titular, retenção e exclusão da conta', () => {
    const privacy = require('../src/services/privacy.service');
    const { Tenant } = require('../src/models');
    const adm = () => ({ authorization: `Bearer ${token}` });

    test('exporta os dados do lead e registra o pedido sem guardar o telefone', async () => {
      const l = await leadRow(LEAD);
      const res = await request(app).get(`/api/v1/leads/${l.id}/privacy-export`).set(adm());
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="dados-do-lead-/);
      expect(res.body.data.titular.telefone).toBe(LEAD);
      expect(res.body.data.conversa.length).toBeGreaterThan(0);
      expect(res.body.data.atendimento.informouAoAtendimento.rendaMensalReais).toBe(8000);
      const [pedido] = await owner.query(`SELECT kind, subject_ref FROM aim_privacy_request WHERE kind = 'exportacao' ORDER BY created_at DESC LIMIT 1`, { type: 'SELECT' });
      expect(pedido.subject_ref).toBe(privacy.subjectRef(l.tenant_id, LEAD));
      expect(pedido.subject_ref).not.toContain(LEAD);
    });

    test('exclui a pedido: some a conversa, o telefone e os textos; ficam só os números do funil', async () => {
      const antes = await leadRow(LEAD);
      const res = await request(app).delete(`/api/v1/leads/${antes.id}`).set(adm());
      expect(res.status).toBe(200);
      const [depois] = await owner.query('SELECT * FROM aim_lead WHERE id = :id', { replacements: { id: antes.id }, type: 'SELECT' });
      expect(depois.wa_id).toMatch(/^000\d{12}$/);
      expect(depois).toMatchObject({ display_name: null, visit_preference: null, handoff_summary: null, handoff_reason: null, bot_active: false });
      expect(depois.qualification).toEqual({});
      expect(depois.open_questions).toEqual([]);
      expect(depois.anonymized_at).not.toBeNull();
      expect(depois.classification).toBe(antes.classification); // funil preservado
      const [{ n }] = await owner.query('SELECT count(*)::int AS n FROM aim_message WHERE lead_id = :id', { replacements: { id: antes.id }, type: 'SELECT' });
      expect(n).toBe(0);
      // Nada mais pode ser feito com o lead anonimizado
      expect((await request(app).get(`/api/v1/leads/${antes.id}/privacy-export`).set(adm())).status).toBe(409);
      expect((await request(app).patch(`/api/v1/leads/${antes.id}`).set(adm()).send({ status: 'em_atendimento' })).status).toBe(409);
      expect((await request(app).post(`/api/v1/leads/${antes.id}/messages`).set(adm()).send({ text: 'oi' })).status).toBe(409);
      expect((await request(app).delete(`/api/v1/leads/${antes.id}`).set(adm())).status).toBe(200); // idempotente
      const pedidos = await owner.query(`SELECT count(*)::int AS n FROM aim_privacy_request WHERE kind = 'exclusao'`, { type: 'SELECT' });
      expect(pedidos[0].n).toBe(1);
    });

    test('a mesma pessoa escrevendo de novo vira um lead novo', async () => {
      ai.runTurn.mockResolvedValue({
        reply: 'Oi de novo!', facts: {}, propertyCode: null, visitPreference: null, nextAction: 'continuar', handoffReason: null, handoffSummary: null, openQuestions: [],
      });
      await post(payload(LEAD, 'Oi, sou eu de novo'));
      const novo = await waitFor(async () => leadRow(LEAD));
      expect(novo.anonymized_at).toBeNull();
      expect(novo.status).toBe('em_atendimento');
    });

    test('corretor não exporta nem exclui dados de lead', async () => {
      const l = await request(app).post('/api/v1/auth/login').send({ tenant: 'imob-nova', email: 'corretor@exemplo.com.br', password: 'senha-corretor-1' });
      const auth = { authorization: `Bearer ${l.body.data.accessToken}` };
      const [lead] = await owner.query(`SELECT id FROM aim_lead WHERE wa_id = '5511955550001'`, { type: 'SELECT' });
      expect((await request(app).get(`/api/v1/leads/${lead.id}/privacy-export`).set(auth)).status).toBe(403);
      expect((await request(app).delete(`/api/v1/leads/${lead.id}`).set(auth)).status).toBe(403);
    });

    test('retenção: prazo configurável; lead parado há mais tempo é anonimizado', async () => {
      const login = await request(app).post('/api/v1/auth/login').send({ tenant: 'imob-nova', email: 'ana@exemplo.com.br', password: 'nova-senha-456' });
      const auth = { authorization: `Bearer ${login.body.data.accessToken}` };
      expect((await request(app).patch('/api/v1/account/privacy').set(auth).send({ retentionMonths: 2 })).status).toBe(422);
      const r = await request(app).patch('/api/v1/account/privacy').set(auth).send({ retentionMonths: 3 });
      expect(r.status).toBe(200);
      expect(r.body.data.tenant.retentionMonths).toBe(3);

      await owner.query(
        `UPDATE aim_lead SET created_at = now() - interval '4 months', last_inbound_at = now() - interval '4 months', last_outbound_at = now() - interval '4 months'
          WHERE wa_id = '5511955550001'`
      );
      const tenant = await Tenant.findOne({ where: { slug: 'imob-nova' } });
      const out = await privacy.runRetention(tenant);
      expect(out.leads).toBe(1);
      const [l] = await owner.query(`SELECT anonymized_at FROM aim_lead WHERE tenant_id = :id AND anonymized_at IS NOT NULL`, { replacements: { id: tenant.id }, type: 'SELECT' });
      expect(l.anonymized_at).not.toBeNull();
      expect((await privacy.runRetention(tenant)).leads).toBe(0); // idempotente
    });

    test('exclusão da conta: exige senha e endereço; apaga tudo em cascata', async () => {
      const conta = { accountName: 'Conta Para Apagar', slug: 'apagar-conta', name: 'Dono', email: 'dono@exemplo.com.br', password: 'senha-forte-apagar', acceptTerms: true };
      await owner.query(`DELETE FROM aim_tenant WHERE slug = 'apagar-conta'`);
      const s = await request(app).post('/api/v1/signup').send(conta);
      expect(s.status).toBe(201);
      const auth = { authorization: `Bearer ${s.body.data.accessToken}` };
      await request(app).post('/api/v1/properties').set(auth).send({ code: 'APG1', title: 'Imóvel', priceCents: 100000 });
      expect((await request(app).delete('/api/v1/account').set(auth).send({ password: 'errada', slug: 'apagar-conta' })).status).toBe(403);
      expect((await request(app).delete('/api/v1/account').set(auth).send({ password: conta.password, slug: 'outra-coisa' })).status).toBe(403);
      const ok = await request(app).delete('/api/v1/account').set(auth).send({ password: conta.password, slug: 'apagar-conta' });
      expect(ok.status).toBe(200);
      const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM aim_tenant WHERE slug = 'apagar-conta'`, { type: 'SELECT' });
      expect(n).toBe(0);
      const [{ u }] = await owner.query(`SELECT count(*)::int AS u FROM aim_user WHERE email = 'dono@exemplo.com.br'`, { type: 'SELECT' });
      expect(u).toBe(0);
      expect((await request(app).post('/api/v1/auth/login').send({ tenant: 'apagar-conta', email: conta.email, password: conta.password })).status).toBe(401);
      // A outra conta segue intacta
      const [{ c }] = await owner.query(`SELECT count(*)::int AS c FROM aim_tenant WHERE slug = :s`, { replacements: { s: process.env.SEED_TENANT_SLUG }, type: 'SELECT' });
      expect(c).toBe(1);
    });
  });

  describe('conectar o WhatsApp pelo painel (cadastro incorporado)', () => {
    const env = require('../src/config/env');
    const meta = require('../src/services/whatsapp/meta');
    const { decrypt } = require('../src/services/crypto');
    const original = {};
    let auth;
    let tenantId;
    const body = { code: 'codigo-do-login-da-meta-123', wabaId: '1029384756', phoneNumberId: '5647382910' };

    beforeAll(async () => {
      Object.assign(original, { app: env.META_APP_ID, cfg: env.META_ES_CONFIG_ID, on: env.embeddedSignup });
      const login = await request(app).post('/api/v1/auth/login').send({ tenant: 'imob-nova', email: 'ana@exemplo.com.br', password: 'nova-senha-456' });
      auth = { authorization: `Bearer ${login.body.data.accessToken}` };
      [{ id: tenantId }] = await owner.query(`SELECT id FROM aim_tenant WHERE slug = 'imob-nova'`, { type: 'SELECT' });
    });
    afterAll(() => {
      env.META_APP_ID = original.app;
      env.META_ES_CONFIG_ID = original.cfg;
      env.embeddedSignup = original.on;
      jest.restoreAllMocks();
    });
    const ligar = () => {
      env.META_APP_ID = '111222333444';
      env.META_ES_CONFIG_ID = '555666777888';
      env.embeddedSignup = true;
    };

    test('sem configuração da Meta: botão escondido e rota indisponível', async () => {
      env.embeddedSignup = false;
      const acc = await request(app).get('/api/v1/account').set(auth);
      expect(acc.body.data.whatsappSignup).toBeNull();
      expect((await request(app).post('/api/v1/whatsapp/connect').set(auth).send(body)).status).toBe(503);
    });

    test('conecta: troca o código, assina os avisos, registra o número e grava o token cifrado', async () => {
      ligar();
      const acc = await request(app).get('/api/v1/account').set(auth);
      expect(acc.body.data.whatsappSignup).toEqual({ appId: '111222333444', configId: '555666777888', graphVersion: env.WA_GRAPH_VERSION });

      const ex = jest.spyOn(meta, 'exchangeCode').mockResolvedValue('EAAG-token-da-empresa');
      const sub = jest.spyOn(meta, 'subscribeApp').mockResolvedValue({ success: true });
      const reg = jest.spyOn(meta, 'registerNumber').mockResolvedValue({ success: true });
      jest.spyOn(meta, 'getPhoneInfo').mockResolvedValue({ displayPhone: '5511933334444', verifiedName: 'Imob Nova', quality: 'GREEN', messagingLimit: 'TIER_250' });

      const res = await request(app).post('/api/v1/whatsapp/connect').set(auth).send(body);
      expect(res.status).toBe(200);
      expect(res.body.data.tenant.whatsappConnected).toBe(true);
      expect(res.body.data.onboarding.steps.find((s) => s.key === 'whatsapp').done).toBe(true);
      expect(ex).toHaveBeenCalledWith(body.code);
      expect(sub).toHaveBeenCalledWith(body.wabaId, 'EAAG-token-da-empresa');
      expect(reg.mock.calls[0][2]).toMatch(/^\d{6}$/); // PIN novo de 6 dígitos

      const [t] = await owner.query('SELECT wa_phone_number_id, wa_display_phone, wa_waba_id, wa_access_token_enc FROM aim_tenant WHERE id = :id', { replacements: { id: tenantId }, type: 'SELECT' });
      expect(t).toMatchObject({ wa_phone_number_id: body.phoneNumberId, wa_display_phone: '5511933334444', wa_waba_id: body.wabaId });
      expect(t.wa_access_token_enc).not.toContain('EAAG');
      expect(decrypt(t.wa_access_token_enc, tenantId)).toBe('EAAG-token-da-empresa');

      const st = await request(app).get('/api/v1/whatsapp').set(auth);
      expect(st.body.data).toMatchObject({ connected: true, displayPhone: '5511933334444', verifiedName: 'Imob Nova', quality: 'GREEN', ownToken: true, live: true });
    });

    test('número de outra conta é recusado; falha da Meta não grava nada', async () => {
      ligar();
      // Admin do seed tentando conectar o número da imob-nova
      const outro = await request(app).post('/api/v1/whatsapp/connect').set('authorization', `Bearer ${token}`).send(body);
      expect(outro.status).toBe(409);
      expect(outro.body.error.code).toBe('WA_NUMBER_IN_USE');

      const AppError = require('../src/errors/AppError');
      jest.spyOn(meta, 'registerNumber').mockRejectedValueOnce(new AppError('WA_CONNECT_FAILED', 'recusado', 502));
      const falha = await request(app).post('/api/v1/whatsapp/connect').set(auth).send({ ...body, phoneNumberId: '9998887776' });
      expect(falha.status).toBe(502);
      const [t] = await owner.query('SELECT wa_phone_number_id FROM aim_tenant WHERE id = :id', { replacements: { id: tenantId }, type: 'SELECT' });
      expect(t.wa_phone_number_id).toBe(body.phoneNumberId); // continua o anterior
    });

    test('corretor não conecta nem desconecta', async () => {
      ligar();
      const l = await request(app).post('/api/v1/auth/login').send({ tenant: 'imob-nova', email: 'corretor@exemplo.com.br', password: 'senha-corretor-1' });
      const a = { authorization: `Bearer ${l.body.data.accessToken}` };
      expect((await request(app).post('/api/v1/whatsapp/connect').set(a).send(body)).status).toBe(403);
      expect((await request(app).post('/api/v1/whatsapp/disconnect').set(a)).status).toBe(403);
    });

    test('desconecta: tira a assinatura dos avisos e apaga número, ids e token', async () => {
      const un = jest.spyOn(meta, 'unsubscribeApp').mockResolvedValue({ success: true });
      const res = await request(app).post('/api/v1/whatsapp/disconnect').set(auth);
      expect(res.status).toBe(200);
      expect(res.body.data.tenant.whatsappConnected).toBe(false);
      expect(un).toHaveBeenCalledWith(body.wabaId, 'EAAG-token-da-empresa');
      const [t] = await owner.query('SELECT wa_phone_number_id, wa_display_phone, wa_waba_id, wa_access_token_enc FROM aim_tenant WHERE id = :id', { replacements: { id: tenantId }, type: 'SELECT' });
      expect(t).toEqual({ wa_phone_number_id: null, wa_display_phone: null, wa_waba_id: null, wa_access_token_enc: null });
    });
  });

  describe('agenda de visitas', () => {
    const visitService = require('../src/services/visit.service');
    const { Tenant } = require('../src/models');
    const adm = () => ({ authorization: `Bearer ${token}` });
    const L_AGENDA = '5511977001100';
    const L_FORA = '5511977001101';
    const L_LEMBRETE = '5511977001102';
    const fatos = { monthlyIncomeCents: null, guarantee: null, occupants: null, hasPets: null, moveInDays: null, wantsVisit: true };
    const turno = (extra) => ({ reply: 'Certo!', facts: fatos, propertyCode: 'CASA01', visitPreference: null, visitSlot: null, nextAction: 'continuar', handoffReason: null, handoffSummary: null, openQuestions: [], ...extra });

    beforeAll(async () => {
      const dias = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, ['07:00-21:00']]));
      await owner.query(`UPDATE aim_tenant SET visit_schedule = CAST(:s AS jsonb) WHERE slug = :slug`, {
        replacements: { s: JSON.stringify({ slotMinutes: 60, days: dias }), slug: process.env.SEED_TENANT_SLUG },
      });
    });
    afterAll(async () => {
      await owner.query(`UPDATE aim_tenant SET visit_schedule = '{"slotMinutes":60,"days":{}}' WHERE slug = :slug`, { replacements: { slug: process.env.SEED_TENANT_SLUG } });
    });

    test('a IA oferece horários livres e marca o que o lead escolheu', async () => {
      ai.runTurn.mockReset();
      let prompt = '';
      ai.runTurn.mockImplementation(async ({ system }) => {
        prompt = system;
        const m = /\(id: ([^)]+)\)/.exec(system);
        return turno({ reply: 'Visita marcada!', visitSlot: m ? m[1] : null });
      });
      await post(payload(L_AGENDA, 'Olá! Tenho interesse no imóvel #CASA01'));
      const l = await waitFor(async () => {
        const r = await leadRow(L_AGENDA);
        return r && r.status === 'visita_agendada' ? r : null;
      });
      expect(prompt).toContain('<horarios_disponiveis>');
      expect(l.bot_active).toBe(true); // a assistente segue tirando dúvidas até a visita
      expect(l.handoff_reason).toBe('visita_agendada');
      expect(l.visit_preference).toMatch(/^\w{3} \d{2}\/\d{2} às \d{2}:00$/);
      const [v] = await owner.query('SELECT status, created_by, starts_at FROM aim_visit WHERE lead_id = :id', { replacements: { id: l.id }, type: 'SELECT' });
      expect(v).toMatchObject({ status: 'agendada', created_by: 'assistente' });
      expect(new Date(v.starts_at).toISOString()).toBe(/\(id: ([^)]+)\)/.exec(prompt)[1]);
    });

    test('horário fora da lista oferecida é ignorado', async () => {
      ai.runTurn.mockReset();
      ai.runTurn.mockResolvedValue(turno({ visitSlot: '2030-01-01T13:00:00.000Z' }));
      await post(payload(L_FORA, 'Olá! Tenho interesse no imóvel #CASA01'));
      await waitFor(async () => ai.runTurn.mock.calls.length === 1);
      const l = await waitFor(async () => {
        const r = await leadRow(L_FORA);
        return r && r.last_replied_inbound_at ? r : null;
      });
      expect(l.status).toBe('em_atendimento');
      const [{ n }] = await owner.query('SELECT count(*)::int AS n FROM aim_visit WHERE lead_id = :id', { replacements: { id: l.id }, type: 'SELECT' });
      expect(n).toBe(0);
    });

    test('painel: horários livres, agendar, conflito, remarcar e concluir', async () => {
      const agendado = await owner.query(`SELECT starts_at FROM aim_visit WHERE status = 'agendada'`, { type: 'SELECT' });
      const slots = (await request(app).get('/api/v1/visits/slots').set(adm())).body.data.slots;
      expect(slots.length).toBeGreaterThan(5);
      expect(slots.map((s) => s.startsAt)).not.toContain(new Date(agendado[0].starts_at).toISOString()); // ocupado sai
      const fora = await leadRow(L_FORA);
      const criar = await request(app).post('/api/v1/visits').set(adm()).send({ leadId: fora.id, startsAt: slots[0].startsAt });
      expect(criar.status).toBe(201);
      // Mesmo horário para outro lead: conflito
      const outro = await leadRow(L_AGENDA);
      const conflito = await request(app).patch(`/api/v1/visits/${(await owner.query('SELECT id FROM aim_visit WHERE lead_id = :id', { replacements: { id: outro.id }, type: 'SELECT' }))[0].id}`).set(adm()).send({ startsAt: slots[0].startsAt });
      expect(conflito.status).toBe(409);
      expect(conflito.body.error.code).toBe('VISIT_CONFLICT');
      // Remarcar e concluir
      const remarcar = await request(app).patch(`/api/v1/visits/${criar.body.data.id}`).set(adm()).send({ startsAt: slots[1].startsAt });
      expect(remarcar.status).toBe(200);
      expect((await request(app).patch(`/api/v1/visits/${criar.body.data.id}`).set(adm()).send({ status: 'realizada' })).status).toBe(200);
      expect((await request(app).patch(`/api/v1/visits/${criar.body.data.id}`).set(adm()).send({ status: 'cancelada' })).status).toBe(409);
      expect((await request(app).patch(`/api/v1/visits/${criar.body.data.id}`).set(adm()).send({ status: 'realizada', startsAt: slots[2].startsAt })).status).toBe(422);
      const lista = await request(app).get('/api/v1/visits').set(adm());
      expect(lista.body.data.visits.map((v) => v.status).sort()).toEqual(['agendada', 'realizada']);
      expect(lista.body.data.visits[0].label).toMatch(/às/);
    });

    test('cancelar a visita devolve o lead para o corretor', async () => {
      const l = await leadRow(L_AGENDA);
      const [v] = await owner.query(`SELECT id FROM aim_visit WHERE lead_id = :id AND status = 'agendada'`, { replacements: { id: l.id }, type: 'SELECT' });
      expect((await request(app).patch(`/api/v1/visits/${v.id}`).set(adm()).send({ status: 'cancelada' })).status).toBe(200);
      expect((await leadRow(L_AGENDA)).status).toBe('transferido');
    });

    test('lembrete nas 24 h antes: texto livre dentro da janela, uma vez só', async () => {
      ai.runTurn.mockReset();
      ai.runTurn.mockResolvedValue(turno({}));
      await post(payload(L_LEMBRETE, 'Olá! Tenho interesse no imóvel #CASA01'));
      const l = await waitFor(async () => leadRow(L_LEMBRETE));
      const slots = (await request(app).get('/api/v1/visits/slots').set(adm())).body.data.slots;
      const dentro = slots.find((s) => new Date(s.startsAt) - Date.now() > 1.5 * 3600e3 && new Date(s.startsAt) - Date.now() < 23 * 3600e3);
      expect(dentro).toBeDefined();
      expect((await request(app).post('/api/v1/visits').set(adm()).send({ leadId: l.id, startsAt: dentro.startsAt })).status).toBe(201);
      const tenant = await Tenant.findOne({ where: { slug: process.env.SEED_TENANT_SLUG } });
      wa.sendText.mockClear();
      expect(await visitService.sendDueReminders(tenant)).toBe(1);
      expect(wa.sendText.mock.calls.at(-1)[1]).toBe(L_LEMBRETE);
      expect(wa.sendText.mock.calls.at(-1)[2]).toContain('lembrar da visita ao imóvel #CASA01');
      expect(await visitService.sendDueReminders(tenant)).toBe(0);
    });

    test('o funil conta as visitas da agenda', async () => {
      const f = await request(app).get('/api/v1/metrics/funnel').set(adm());
      expect(f.body.data.visitas).toBeGreaterThanOrEqual(2);
    });
  });

  describe('rotina do dono: avisos, resumo e configurações', () => {
    const quality = require('../src/services/quality.service');
    const digest = require('../src/services/digest.service');
    const jobService = require('../src/services/job.service');
    const { zonedToUtc, localParts } = require('../src/services/time');
    const { Tenant } = require('../src/models');
    const adm = () => ({ authorization: `Bearer ${token}` });
    const seed = () => Tenant.findOne({ where: { slug: process.env.SEED_TENANT_SLUG } });

    test('lead transferido sem retorno vira aviso e some quando o corretor responde', async () => {
      const l = await leadRow('5511977001101');
      await owner.query(`UPDATE aim_lead SET status = 'transferido', bot_active = false, handoff_at = now() - interval '3 hours' WHERE id = :id`, { replacements: { id: l.id } });
      await quality.sync(await seed());
      const hoje = await request(app).get('/api/v1/today').set(adm());
      const aviso = hoje.body.data.avisos.find((a) => a.kind === 'lead_sem_retorno' && a.lead.id === l.id);
      expect(aviso.details.minutos).toBeGreaterThanOrEqual(179);
      expect(hoje.body.data.resumo.aguardando).toBeGreaterThanOrEqual(1);
      await owner.query(
        `INSERT INTO aim_message (tenant_id, lead_id, direction, author, body) VALUES (:t, :id, 'out', 'human', 'Oi, sou o corretor')`,
        { replacements: { t: l.tenant_id, id: l.id } }
      );
      await quality.sync(await seed());
      const [a] = await owner.query('SELECT resolved_at, resolved_by FROM aim_alert WHERE id = :id', { replacements: { id: aviso.id }, type: 'SELECT' });
      expect(a.resolved_by).toBe('automatico');
    });

    test('cadastro incompleto: 3 leads com dúvidas; editar o imóvel resolve', async () => {
      const [kit] = await owner.query(`SELECT id FROM aim_property WHERE code = 'KIT01' AND tenant_id = (SELECT id FROM aim_tenant WHERE slug = :s)`, { replacements: { s: process.env.SEED_TENANT_SLUG }, type: 'SELECT' });
      const leads = await owner.query(`SELECT id FROM aim_lead WHERE tenant_id = (SELECT id FROM aim_tenant WHERE slug = :s) AND anonymized_at IS NULL LIMIT 3`, { replacements: { s: process.env.SEED_TENANT_SLUG }, type: 'SELECT' });
      expect(leads).toHaveLength(3);
      await owner.query(`UPDATE aim_lead SET property_id = :p, open_questions = '["Tem garagem?"]', open_questions_at = now() + interval '1 second' WHERE id IN (:ids)`, { replacements: { p: kit.id, ids: leads.map((x) => x.id) } });
      await quality.sync(await seed());
      const hoje = await request(app).get('/api/v1/today').set(adm());
      const aviso = hoje.body.data.avisos.find((a) => a.kind === 'cadastro_incompleto');
      expect(aviso.property.code).toBe('KIT01');
      expect(aviso.details).toMatchObject({ leads: 3, perguntas: ['Tem garagem?'] });
      await new Promise((r) => setTimeout(r, 1100));
      expect((await request(app).patch(`/api/v1/properties/${kit.id}`).set(adm()).send({ extraInfo: 'Sem garagem.' })).status).toBe(200);
      await quality.sync(await seed());
      const depois = await request(app).get('/api/v1/today').set(adm());
      expect(depois.body.data.avisos.find((a) => a.kind === 'cadastro_incompleto')).toBeUndefined();
      // Os mesmos leads seguem conversando (atualização comum, sem dúvida nova): o aviso não volta.
      await owner.query(`UPDATE aim_lead SET updated_at = now() + interval '5 seconds' WHERE id IN (:ids)`, { replacements: { ids: leads.map((x) => x.id) } });
      await quality.sync(await seed());
      const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM aim_alert WHERE kind = 'cadastro_incompleto' AND resolved_at IS NULL`, { type: 'SELECT' });
      expect(n).toBe(0);
    });

    test('resposta que esgotou as tentativas vira aviso; dá para marcar como resolvido', async () => {
      const l = await leadRow('5511977001102');
      const [j] = await owner.query(
        `INSERT INTO aim_job (tenant_id, kind, lead_id, serial_key, status, attempts, max_attempts, locked_at) VALUES (:t, 'reply', :id, :k, 'executando', 5, 5, now()) RETURNING id`,
        { replacements: { t: l.tenant_id, id: l.id, k: `reply:${l.id}` }, type: 'SELECT' }
      );
      expect(await jobService.fail({ id: j.id, tenantId: l.tenant_id, kind: 'reply' }, Object.assign(new Error('x'), { code: 'WHATSAPP_SEND_FAILED' }))).toBe('failed');
      const hoje = await request(app).get('/api/v1/today').set(adm());
      const aviso = hoje.body.data.avisos.find((a) => a.kind === 'falha_envio' && a.lead.id === l.id);
      expect(aviso.details).toEqual({ codigo: 'WHATSAPP_SEND_FAILED', tentativas: 5 });
      expect((await request(app).patch(`/api/v1/alerts/${aviso.id}`).set(adm()).send({})).status).toBe(200);
      expect((await request(app).patch(`/api/v1/alerts/${aviso.id}`).set(adm()).send({})).status).toBe(404);
    });

    test('resumo diário: depois das 8h locais, uma vez por dia, desligável', async () => {
      const tenant = await seed();
      const p = localParts(new Date(), tenant.timezone);
      const as = (h) => zonedToUtc({ y: p.y, m: p.m, d: p.d, h, mi: 30 }, tenant.timezone);
      expect(await digest.runDue(tenant, as(7))).toBe('nao_e_hora');
      expect(await digest.runDue(tenant, as(8))).toBe('so_painel'); // há o que mostrar; sem template, só no painel
      expect(await digest.runDue(tenant, as(9))).toBe('ja_enviado');
      const [d] = await owner.query('SELECT counts, delivery FROM aim_digest WHERE tenant_id = :id', { replacements: { id: tenant.id }, type: 'SELECT' });
      expect(d.delivery).toBe('so_painel');
      expect(Object.keys(d.counts).sort()).toEqual(['aguardando', 'avisos', 'esperaMaisLongaMin', 'novosOntem', 'quentesAguardando', 'quentesOntem', 'visitasHoje']);
      const off = await request(app).patch('/api/v1/account/routine').set(adm()).send({ digestEnabled: false });
      expect(off.body.data.tenant.digestEnabled).toBe(false);
      expect(await digest.runDue(await seed(), as(10))).toBe('desligado');
      await request(app).patch('/api/v1/account/routine').set(adm()).send({ digestEnabled: true });
    });

    test('configurações: fuso e grade validados; corretor não altera', async () => {
      expect((await request(app).patch('/api/v1/account/routine').set(adm()).send({ timezone: 'America/Nowhere' })).status).toBe(422);
      const ok = await request(app).patch('/api/v1/account/routine').set(adm()).send({ timezone: 'America/Manaus', handoffSlaMinutes: 60 });
      expect(ok.body.data.tenant).toMatchObject({ timezone: 'America/Manaus', handoffSlaMinutes: 60 });
      await request(app).patch('/api/v1/account/routine').set(adm()).send({ timezone: 'America/Sao_Paulo', handoffSlaMinutes: 120 });
      expect((await request(app).patch('/api/v1/account/visit-schedule').set(adm()).send({ slotMinutes: 60, days: { 1: ['09:00-12:00', '11:00-13:00'] } })).status).toBe(422);
      const grade = await request(app).patch('/api/v1/account/visit-schedule').set(adm()).send({ slotMinutes: 90, days: { 1: ['09:00-12:00'], 3: [] } });
      expect(grade.body.data.tenant.visitSchedule).toEqual({ slotMinutes: 90, days: { 1: ['09:00-12:00'] } });
      const l = await request(app).post('/api/v1/auth/login').send({ tenant: 'imob-nova', email: 'corretor@exemplo.com.br', password: 'senha-corretor-1' });
      const corretor = { authorization: `Bearer ${l.body.data.accessToken}` };
      expect((await request(app).patch('/api/v1/account/routine').set(corretor).send({ digestEnabled: false })).status).toBe(403);
      expect((await request(app).patch('/api/v1/account/visit-schedule').set(corretor).send({ slotMinutes: 60, days: {} })).status).toBe(403);
      await owner.query(`UPDATE aim_tenant SET visit_schedule = '{"slotMinutes":60,"days":{}}' WHERE slug = :s`, { replacements: { s: process.env.SEED_TENANT_SLUG } });
    });
  });

  describe('modo piloto: cobrança e cadastro desligados, contas pelo comando', () => {
    const env = require('../src/config/env');
    const conversation = require('../src/services/conversation.service');
    const cli = require('../src/db/conta-cli');
    const { decrypt } = require('../src/services/crypto');
    const original = {};
    let authNova;
    let novaId;

    beforeAll(async () => {
      Object.assign(original, { billing: env.billingEnabled, signup: env.signupEnabled });
      env.billingEnabled = false;
      env.signupEnabled = false;
      const login = await request(app).post('/api/v1/auth/login').send({ tenant: 'imob-nova', email: 'ana@exemplo.com.br', password: 'nova-senha-456' });
      authNova = { authorization: `Bearer ${login.body.data.accessToken}` };
      [{ id: novaId }] = await owner.query(`SELECT id FROM aim_tenant WHERE slug = 'imob-nova'`, { type: 'SELECT' });
      await owner.query(`DELETE FROM aim_tenant WHERE slug IN ('piloto-teste')`);
    });
    afterAll(() => {
      env.billingEnabled = original.billing;
      env.signupEnabled = original.signup;
    });

    test('cobrança desligada: teste vencido não trava, sem limite de imóveis, sem planos à venda', async () => {
      await owner.query(`UPDATE aim_subscription SET plan = 'teste', status = 'teste', trial_ends_at = now() - interval '1 day' WHERE tenant_id = :id`, { replacements: { id: novaId } });
      ai.runTurn.mockReset();
      ai.runTurn.mockResolvedValue({ reply: 'Oi!', facts: {}, propertyCode: null, visitPreference: null, nextAction: 'continuar', handoffReason: null, handoffSummary: null, openQuestions: [] });
      await conversation.acceptSimulated(novaId, { phoneNumberId: null, waMessageId: `sim-${crypto.randomUUID()}`, waId: '5511955559999', name: 'Piloto', type: 'text', text: 'Oi', timestamp: new Date(), referralSource: null });
      await waitFor(async () => ai.runTurn.mock.calls.length === 1); // a assistente atende
      const b = await request(app).get('/api/v1/billing').set(authNova);
      expect(b.body.data.billing.enabled).toBe(false);
      expect(b.body.data.plans).toEqual([]);
      expect(b.body.data.subscription).toMatchObject({ planName: 'Piloto', active: true, reason: null });
      expect(b.body.data.limits.conversations).toBeNull();
      expect((await request(app).post('/api/v1/billing/checkout').set(authNova).send({ plan: 'essencial', document: '52998224725' })).status).toBe(503);
      for (let i = 0; i < 2; i += 1) {
        expect((await request(app).post('/api/v1/properties').set(authNova).send({ code: `PIL${i}`, title: 'Piloto', priceCents: 100000 })).status).toBe(201);
      }
      // O que estava gravado não muda: ao religar a cobrança, vale o plano da conta.
      const [s] = await owner.query('SELECT plan, status FROM aim_subscription WHERE tenant_id = :id', { replacements: { id: novaId }, type: 'SELECT' });
      expect(s).toEqual({ plan: 'teste', status: 'teste' });
    });

    test('cadastro fechado: o painel esconde e a API recusa', async () => {
      const cfg = await request(app).get('/api/v1/public-config');
      expect(cfg.body.data).toEqual({ signupEnabled: false, billingEnabled: false });
      const r = await request(app).post('/api/v1/signup').send({ accountName: 'Nova', slug: 'fechado-teste', name: 'X', email: 'x@exemplo.com.br', password: 'senha-forte-123', acceptTerms: true });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('SIGNUP_CLOSED');
    });

    test('comando criar: conta com admin confirmado, plano interno; login funciona', async () => {
      const out = await cli.criar(owner, { slug: 'piloto-teste', nome: 'Imobiliária Piloto', 'admin-nome': 'Dona Piloto', 'admin-email': 'Dona@Piloto.com.br', assistente: 'Sofia' }, { CONTA_SENHA: 'senha-do-piloto-1' });
      expect(out).toMatchObject({ slug: 'piloto-teste', email: 'dona@piloto.com.br' });
      await expect(cli.criar(owner, { slug: 'piloto-teste', nome: 'Outra Conta', 'admin-nome': 'Fulano', 'admin-email': 'y@y.com.br' }, { CONTA_SENHA: 'senha-do-piloto-1' })).rejects.toThrow(/Já existe/);
      await expect(cli.criar(owner, { slug: 'outra-piloto', nome: 'Outra Conta', 'admin-nome': 'Fulano', 'admin-email': 'y@y.com.br' }, { CONTA_SENHA: 'curta' })).rejects.toThrow(/CONTA_SENHA/);
      const login = await request(app).post('/api/v1/auth/login').send({ tenant: 'piloto-teste', email: 'dona@piloto.com.br', password: 'senha-do-piloto-1' });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ role: 'admin', emailVerified: true });
      const [s] = await owner.query(`SELECT plan, status FROM aim_subscription WHERE tenant_id = (SELECT id FROM aim_tenant WHERE slug = 'piloto-teste')`, { type: 'SELECT' });
      expect(s).toEqual({ plan: 'interno', status: 'ativa' });
      const acc = await request(app).get('/api/v1/account').set('authorization', `Bearer ${login.body.data.accessToken}`);
      expect(acc.body.data.tenant).toMatchObject({ name: 'Imobiliária Piloto', assistantName: 'Sofia', timezone: 'America/Sao_Paulo' });
    });

    test('comando senha: troca a senha e encerra as sessões', async () => {
      const antes = await request(app).post('/api/v1/auth/login').send({ tenant: 'piloto-teste', email: 'dona@piloto.com.br', password: 'senha-do-piloto-1' });
      await cli.senha(owner, { slug: 'piloto-teste', email: 'DONA@piloto.com.br' }, { CONTA_SENHA: 'senha-nova-piloto-2' });
      expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: antes.body.data.refreshToken })).status).toBe(401);
      expect((await request(app).post('/api/v1/auth/login').send({ tenant: 'piloto-teste', email: 'dona@piloto.com.br', password: 'senha-nova-piloto-2' })).status).toBe(200);
      await expect(cli.senha(owner, { slug: 'piloto-teste', email: 'ninguem@piloto.com.br' }, { CONTA_SENHA: 'senha-nova-piloto-3' })).rejects.toThrow(/não encontrado/);
    });

    test('comando whatsapp: grava número, dono e token cifrado; recusa número de outra conta; desconecta', async () => {
      const [pil] = await owner.query(`SELECT id FROM aim_tenant WHERE slug = 'piloto-teste'`, { type: 'SELECT' });
      const out = await cli.whatsapp(owner, { slug: 'piloto-teste', 'phone-id': '777888999000', numero: '5511944443333', dono: '5511922221111', waba: '12345678' }, { WA_TOKEN_NEW: 'EAAG-token-do-piloto-123456' });
      expect(out).toEqual({ slug: 'piloto-teste', conectado: true, tokenProprio: true });
      const [t] = await owner.query('SELECT wa_phone_number_id, wa_display_phone, owner_whatsapp, wa_waba_id, wa_access_token_enc FROM aim_tenant WHERE id = :id', { replacements: { id: pil.id }, type: 'SELECT' });
      expect(t).toMatchObject({ wa_phone_number_id: '777888999000', wa_display_phone: '5511944443333', owner_whatsapp: '5511922221111', wa_waba_id: '12345678' });
      expect(decrypt(t.wa_access_token_enc, pil.id)).toBe('EAAG-token-do-piloto-123456');
      // Sem token novo, mantém o que estava
      await cli.whatsapp(owner, { slug: 'piloto-teste', 'phone-id': '777888999000', numero: '5511944443334' }, {});
      const [t2] = await owner.query('SELECT wa_display_phone, wa_access_token_enc FROM aim_tenant WHERE id = :id', { replacements: { id: pil.id }, type: 'SELECT' });
      expect(t2.wa_display_phone).toBe('5511944443334');
      expect(t2.wa_access_token_enc).toBe(t.wa_access_token_enc);
      await expect(cli.whatsapp(owner, { slug: 'imob-nova', 'phone-id': '777888999000', numero: '5511944443333' }, {})).rejects.toThrow(/já está na conta "piloto-teste"/);
      await expect(cli.whatsapp(owner, { slug: 'piloto-teste', 'phone-id': '777888999000', numero: '119444' }, {})).rejects.toThrow(/DDI/);
      expect(await cli.whatsapp(owner, { slug: 'piloto-teste', desconectar: true }, {})).toEqual({ slug: 'piloto-teste', conectado: false });
    });

    test('comandos plano e listar', async () => {
      expect(await cli.plano(owner, { slug: 'piloto-teste', plano: 'teste' })).toEqual({ slug: 'piloto-teste', plano: 'teste', situacao: 'teste' });
      await expect(cli.plano(owner, { slug: 'piloto-teste', plano: 'ouro' })).rejects.toThrow(/Plano desconhecido/);
      await cli.plano(owner, { slug: 'piloto-teste', plano: 'interno' });
      const lista = await cli.listar(owner);
      expect(lista.find((c) => c.slug === 'piloto-teste')).toMatchObject({ plano: 'interno', situacao: 'ativa', usuarios: 1, leads: 0, whatsapp: false });
      expect(cli.parseArgs(['criar', '--slug', 'x', '--desconectar'])).toEqual({ command: 'criar', opts: { slug: 'x', desconectar: true } });
    });
  });

  test('login com senha errada', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ tenant: process.env.SEED_TENANT_SLUG, email: process.env.SEED_ADMIN_EMAIL, password: 'errada' });
    expect(res.status).toBe(401);
  });
});
