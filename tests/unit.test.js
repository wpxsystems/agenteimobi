'use strict';

const crypto = require('crypto');
const { scoreLead, mergeQualification } = require('../src/services/scoring');
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
