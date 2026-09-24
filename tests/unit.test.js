'use strict';

const crypto = require('crypto');
const { scoreLead, mergeQualification, findAlternatives, mergeOpenQuestions, describeQualification } = require('../src/services/scoring');
const { isValidSignature } = require('../src/services/whatsapp/signature');
const { parseWebhook, extractPropertyCode } = require('../src/services/whatsapp/webhookParser');
const { toClaudeMessages, toInternal, outputSchema } = require('../src/services/ai/claude.client');
const { buildWaLink, buildTrackedLink } = require('../src/services/property.service');
const { OPT_OUT_RE } = require('../src/services/conversation.service');
const schemas = require('../src/schemas');

// Aluguel R$ 2.000 + R$ 150 de taxas = custo mensal R$ 2.150
const casa = {
  dealType: 'aluguel',
  priceCents: 200000,
  feesCents: 15000,
  allowsPets: false,
  maxOccupants: 4,
  acceptedGuarantees: ['caucao', 'seguro_fianca'],
};

describe('scoring', () => {
  test('lead completo e compatível = quente (score 100)', () => {
    const r = scoreLead(
      { monthlyIncomeCents: 800000, guarantee: 'caucao', occupants: 2, hasPets: false, moveInDays: 20, wantsVisit: true },
      casa
    );
    // 30 renda (8000/2150 = 3,72x) + 20 garantia + 5 pet + 5 moradores + 20 prazo + 20 visita
    expect(r).toEqual({ score: 100, classification: 'quente', disqualifyReasons: [], knownFacts: 5 });
  });

  test('renda exatamente 2,5x não desqualifica (limite)', () => {
    const r = scoreLead({ monthlyIncomeCents: 537500 }, casa); // 2150 * 2.5
    expect(r.disqualifyReasons).toEqual([]);
    expect(r.score).toBe(15);
  });

  test('renda abaixo de 2,5x desqualifica', () => {
    const r = scoreLead({ monthlyIncomeCents: 537499 }, casa);
    expect(r.classification).toBe('frio');
    expect(r.disqualifyReasons).toContain('renda_insuficiente');
  });

  test('renda exatamente 3x pontua 30', () => {
    expect(scoreLead({ monthlyIncomeCents: 645000 }, casa).score).toBe(30);
  });

  test('pet em imóvel que não aceita = frio, mesmo com score alto', () => {
    const r = scoreLead(
      { monthlyIncomeCents: 900000, guarantee: 'caucao', occupants: 2, hasPets: true, moveInDays: 10, wantsVisit: true },
      casa
    );
    expect(r.classification).toBe('frio');
    expect(r.disqualifyReasons).toEqual(['pet_nao_permitido']);
  });

  test('garantia não aceita e moradores acima do limite acumulam motivos', () => {
    const r = scoreLead({ guarantee: 'fiador', occupants: 6 }, casa);
    expect(r.disqualifyReasons).toEqual(['garantia_nao_aceita', 'moradores_acima_limite']);
  });

  test('imóvel sem lista de garantias aceita qualquer uma', () => {
    expect(scoreLead({ guarantee: 'fiador' }, { ...casa, acceptedGuarantees: [] }).score).toBe(20);
  });

  test('poucos fatos e score baixo = indefinido (ainda qualificando)', () => {
    expect(scoreLead({ hasPets: false, occupants: 2 }, casa).classification).toBe('indefinido');
  });

  test('3+ fatos com score entre 40 e 69 = morno', () => {
    const r = scoreLead({ monthlyIncomeCents: 600000, guarantee: 'caucao', occupants: 2, moveInDays: 90 }, casa);
    // 15 + 20 + 5 + 0
    expect(r.score).toBe(40);
    expect(r.classification).toBe('morno');
  });

  test('prazo: 30 dias = +20, 60 dias = +10, 61 = 0', () => {
    expect(scoreLead({ moveInDays: 30 }, casa).score).toBe(20);
    expect(scoreLead({ moveInDays: 60 }, casa).score).toBe(10);
    expect(scoreLead({ moveInDays: 61 }, casa).score).toBe(0);
  });

  test('sem imóvel definido = indefinido', () => {
    expect(scoreLead({ monthlyIncomeCents: 1 }, null).classification).toBe('indefinido');
  });

  test('venda ignora regra de renda/garantia', () => {
    const r = scoreLead({ monthlyIncomeCents: 1, guarantee: 'fiador' }, { ...casa, dealType: 'venda' });
    expect(r.disqualifyReasons).toEqual([]);
  });

  test('merge não apaga fato conhecido com null', () => {
    expect(mergeQualification({ occupants: 2, hasPets: false }, { occupants: null, hasPets: true, moveInDays: 10 })).toEqual({
      occupants: 2,
      hasPets: true,
      moveInDays: 10,
    });
  });
});

describe('alternativas, dúvidas e resumo', () => {
  const props = [
    { id: 'a', code: 'CASA01', title: 'Casa', isActive: true, ...casa }, // não aceita pet
    { id: 'b', code: 'APTO01', title: 'Apto', isActive: true, dealType: 'aluguel', priceCents: 300000, feesCents: 0, allowsPets: true, maxOccupants: 2, acceptedGuarantees: ['caucao'] },
    { id: 'c', code: 'KIT01', title: 'Kit', isActive: true, dealType: 'aluguel', priceCents: 100000, feesCents: 0, allowsPets: true, maxOccupants: 1, acceptedGuarantees: [] },
    { id: 'd', code: 'CASA02', title: 'Venda', isActive: true, dealType: 'venda', priceCents: 40000000, feesCents: 0, allowsPets: true, maxOccupants: null, acceptedGuarantees: [] },
    { id: 'e', code: 'OFF01', title: 'Inativo', isActive: false, dealType: 'aluguel', priceCents: 100000, feesCents: 0, allowsPets: true, maxOccupants: 5, acceptedGuarantees: [] },
  ];

  test('lead com pet e 2 moradores: exclui o atual, o que não aceita pet, o que só cabe 1 e o inativo', () => {
    const q = { monthlyIncomeCents: 900000, guarantee: 'caucao', occupants: 2, hasPets: true };
    const alt = findAlternatives(q, props, 'a');
    expect(alt.map((p) => p.code)).toEqual(['APTO01', 'CASA02']); // apto: 30+20+5+5=60; venda: 5+5=10
  });

  test('sem fatos, todos os ativos são compatíveis, ordenados por preço, no máximo 3', () => {
    expect(findAlternatives({}, props, null).map((p) => p.code)).toEqual(['KIT01', 'CASA01', 'APTO01']);
  });

  test('dúvidas: normaliza, deduplica sem diferenciar maiúsculas, descarta curtas e limita a 10', () => {
    expect(mergeOpenQuestions(['Tem vaga para moto?'], ['  tem VAGA  para moto? ', 'ok', 'Aceita cheque?'])).toEqual([
      'Tem vaga para moto?',
      'Aceita cheque?',
    ]);
    const many = Array.from({ length: 12 }, (_, i) => `Pergunta número ${i}`);
    expect(mergeOpenQuestions([], many)).toHaveLength(10);
    expect(mergeOpenQuestions(null, undefined)).toEqual([]);
  });

  test('resumo determinístico para o corretor', () => {
    const s = describeQualification({
      name: 'Ana',
      property: { code: 'CASA01', title: 'Casa' },
      qualification: { monthlyIncomeCents: 750000, guarantee: 'caucao', occupants: 3, hasPets: true },
      visitPreference: 'sábado de manhã',
      classification: 'quente',
    });
    // Intl usa espaço inseparável entre "R$" e o valor: normaliza antes de comparar.
    expect(s.replace(/ /g, ' ')).toBe('Ana: interesse em #CASA01 (Casa), classificação quente. Informou: renda R$ 7.500,00, garantia caução, 3 moradores, tem pet. Quer visitar: sábado de manhã.');
    expect(describeQualification({ qualification: {}, classification: 'indefinido' })).toBe('Lead sem nome: interesse em imóvel não definido, classificação ainda qualificando.');
  });
});

describe('métricas: dias da série', () => {
  const { listDays, dayKey } = require('../src/services/metrics.service')._internals;
  test('dia no fuso de São Paulo, não em UTC', () => {
    expect(dayKey('2026-09-25T01:30:00Z')).toBe('2026-09-24'); // 22:30 do dia 24 em SP
  });
  test('lista inclusiva, sem buracos, limitada', () => {
    expect(listDays('2026-09-28T12:00:00Z', '2026-10-02T12:00:00Z')).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    expect(listDays('2026-01-01T12:00:00Z', '2026-12-31T12:00:00Z', 30)).toHaveLength(30);
    expect(listDays('2026-09-28T12:00:00Z', '2026-09-27T12:00:00Z')).toEqual([]);
  });
});

describe('exportação de leads', () => {
  const { leadRow, toCsv, COLUNAS } = require('../src/services/export.service');
  const dto = {
    name: 'Ana "A" Souza', phone: '5511999990000', property: { code: 'CASA01', title: 'Casa' }, classification: 'quente', score: 80,
    status: 'transferido', qualification: { monthlyIncomeCents: 750050, guarantee: 'caucao', occupants: 3, hasPets: true, moveInDays: null, wantsVisit: true },
    visitPreference: 'sábado', disqualifyReasons: [], openQuestions: ['Tem vaga?'], handoffSummary: 'Resumo; com ponto e vírgula', source: 'link',
    createdAt: '2026-09-24T18:00:00.000Z', lastInboundAt: null, handoffAt: '2026-09-24T18:05:00.000Z',
  };
  test('linha com rótulos em português, dinheiro em reais e datas como Date', () => {
    const r = leadRow(dto);
    expect(r).toMatchObject({ nome: 'Ana "A" Souza', imovel: 'CASA01', classificacao: 'Quente', status: 'Transferido ao corretor', renda: 7500.5, garantia: 'Caução', pet: 'Sim', prazo: null, querVisitar: 'Sim', origem: 'Link do anúncio' });
    expect(r.criadoEm).toBeInstanceOf(Date);
    expect(r.ultimaMensagem).toBeNull();
    expect(Object.keys(r)).toEqual(COLUNAS.map((c) => c.key)); // toda coluna tem valor; nenhuma sobra
  });
  test('CSV: BOM, ponto e vírgula, aspas escapadas e vazio para null', () => {
    const csv = toCsv([leadRow(dto), leadRow({ ...dto, qualification: {}, property: null, name: null })]);
    const linhas = csv.split('\r\n');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(linhas[0]).toContain('"Nome";"Telefone";"Imóvel"');
    expect(linhas[1]).toContain('"Ana ""A"" Souza"');
    expect(linhas[1]).toContain('"7500,50"');
    expect(linhas[1]).toContain('"Resumo; com ponto e vírgula"');
    expect(linhas[2].startsWith('"";"5511999990000";"";""')).toBe(true);
    expect(linhas).toHaveLength(3);
  });
  test('schema aceita só csv/xlsx e os filtros do funil', () => {
    expect(schemas.leadExport.parse({}).format).toBe('csv');
    expect(schemas.leadExport.parse({ format: 'xlsx', from: '2026-01-01T00:00:00Z' }).format).toBe('xlsx');
    expect(schemas.leadExport.safeParse({ format: 'pdf' }).success).toBe(false);
    expect(schemas.leadExport.safeParse({ format: 'csv', tenantId: 'x' }).success).toBe(false);
  });
});

describe('assinatura do webhook', () => {
  const secret = 'app-secret';
  const body = Buffer.from('{"a":1}');
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

  test('aceita assinatura correta', () => expect(isValidSignature(body, sig, secret)).toBe(true));
  test('rejeita corpo alterado', () => expect(isValidSignature(Buffer.from('{"a":2}'), sig, secret)).toBe(false));
  test('rejeita secret errado', () => expect(isValidSignature(body, sig, 'outro')).toBe(false));
  test('rejeita header ausente/malformado', () => {
    expect(isValidSignature(body, undefined, secret)).toBe(false);
    expect(isValidSignature(body, 'sha1=abc', secret)).toBe(false);
    expect(isValidSignature(body, 'sha256=zz', secret)).toBe(false);
  });
  test('rejeita corpo já parseado (não Buffer)', () => expect(isValidSignature({ a: 1 }, sig, secret)).toBe(false));
});

describe('parser do webhook', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: '111' },
              contacts: [{ wa_id: '5511988887777', profile: { name: 'Maria' } }],
              messages: [
                { id: 'wamid.1', from: '5511988887777', timestamp: '1700000000', type: 'text', text: { body: 'Oi #casa01' } },
                { id: 'wamid.2', from: '5511988887777', type: 'audio', audio: {} },
                { id: 'wamid.3', from: 'hacker', type: 'text', text: { body: 'x' } },
              ],
            },
          },
          { value: { metadata: { phone_number_id: '111' }, statuses: [{ id: 'wamid.x', status: 'read' }] } },
        ],
      },
    ],
  };

  test('normaliza mensagens, ignora status e remetente inválido', () => {
    const out = parseWebhook(payload);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ phoneNumberId: '111', waMessageId: 'wamid.1', waId: '5511988887777', name: 'Maria', text: 'Oi #casa01' });
    expect(out[1]).toMatchObject({ type: 'audio', text: '' });
  });

  test('payload estranho não quebra', () => {
    expect(parseWebhook(null)).toEqual([]);
    expect(parseWebhook({ object: 'page' })).toEqual([]);
  });

  test('extrai código do imóvel', () => {
    expect(extractPropertyCode('Olá! Tenho interesse no imóvel #casa01 (Casa).')).toBe('CASA01');
    expect(extractPropertyCode('sem código')).toBeNull();
    expect(extractPropertyCode('#ab')).toBeNull();
  });
});

describe('cliente da IA', () => {
  test('histórico vira mensagens alternadas começando por user', () => {
    const msgs = toClaudeMessages([
      { author: 'bot', body: 'aviso antigo' },
      { author: 'lead', body: 'oi' },
      { author: 'lead', body: 'tudo bem?' },
      { author: 'bot', body: 'Olá!' },
      { author: 'human', body: 'Sou o corretor' },
      { author: 'lead', body: '', msgType: 'audio' },
    ]);
    expect(msgs).toEqual([
      { role: 'user', content: 'oi\ntudo bem?' },
      { role: 'assistant', content: 'Olá!\nSou o corretor' },
      { role: 'user', content: '[audio sem texto]' },
    ]);
  });

  test('converte renda em reais para centavos e normaliza código', () => {
    const raw = {
      resposta: 'Oi',
      fatos: { renda_mensal_reais: 5432.1, garantia: 'caucao', moradores: 2, tem_pet: null, prazo_mudanca_dias: null, quer_visitar: null },
      codigo_imovel: '#casa01',
      preferencia_visita: null,
      proxima_acao: 'continuar',
      motivo_transferencia: null,
    };
    const out = toInternal(outputSchema.parse(raw));
    expect(out.facts.monthlyIncomeCents).toBe(543210);
    expect(out.propertyCode).toBe('CASA01');
    // Campos novos ausentes (modelo antigo) não quebram: viram null/[]
    expect(out.handoffSummary).toBeNull();
    expect(out.openQuestions).toEqual([]);
  });

  test('resumo e dúvidas: filtra itens vazios e aceita null', () => {
    const base = { resposta: 'Oi', fatos: {}, proxima_acao: 'transferir_humano' };
    const out = toInternal(outputSchema.parse({ ...base, resumo_para_corretor: '  Quer visitar sábado. ', duvidas_sem_resposta: ['Tem vaga?', ' ', 'ok', null].filter((x) => x !== null) }));
    expect(out.handoffSummary).toBe('Quer visitar sábado.');
    expect(out.openQuestions).toEqual(['Tem vaga?']);
    expect(toInternal(outputSchema.parse({ ...base, resumo_para_corretor: null, duvidas_sem_resposta: null })).openQuestions).toEqual([]);
    expect(outputSchema.safeParse({ ...base, duvidas_sem_resposta: Array(9).fill('x') }).success).toBe(false);
  });

  test('saída fora do formato é rejeitada', () => {
    expect(outputSchema.safeParse({ resposta: '', fatos: {}, proxima_acao: 'continuar' }).success).toBe(false);
    expect(outputSchema.safeParse({ resposta: 'ok', fatos: { garantia: 'cheque' }, proxima_acao: 'continuar' }).success).toBe(false);
    expect(outputSchema.safeParse({ resposta: 'ok', fatos: {}, proxima_acao: 'aprovar_cadastro' }).success).toBe(false);
  });
});

describe('links e opt-out', () => {
  test('link wa.me carrega o código do imóvel', () => {
    const url = buildWaLink('5511900000000', { code: 'CASA01', title: 'Casa' });
    expect(url.startsWith('https://wa.me/5511900000000?text=')).toBe(true);
    expect(decodeURIComponent(url.split('text=')[1])).toContain('#CASA01');
  });

  test('link rastreado', () => {
    expect(buildTrackedLink('cliente-teste', 'CASA01', 'marketplace')).toBe('https://agente.test/r/cliente-teste/CASA01?src=marketplace');
  });

  test('palavras de opt-out', () => {
    ['SAIR', ' sair ', 'Parar!', 'stop'].forEach((t) => expect(OPT_OUT_RE.test(t)).toBe(true));
    ['quero sair de casa em 30 dias', 'saindo'].forEach((t) => expect(OPT_OUT_RE.test(t)).toBe(false));
  });
});

describe('schemas', () => {
  test('rejeita campo desconhecido (tenantId no body)', () => {
    const r = schemas.propertyCreate.safeParse({ code: 'CASA02', title: 'Casa', priceCents: 1000, tenantId: 'x' });
    expect(r.success).toBe(false);
  });

  test('update parcial não injeta defaults', () => {
    expect(schemas.propertyUpdate.parse({ title: 'Novo título' })).toEqual({ title: 'Novo título' });
  });

  test('código do imóvel vira maiúsculo', () => {
    expect(schemas.propertyCreate.parse({ code: 'casa02', title: 'Casa', priceCents: 1000 }).code).toBe('CASA02');
  });
});
