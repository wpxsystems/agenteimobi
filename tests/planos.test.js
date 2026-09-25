'use strict';

// Planos e cobrança sem banco: direito de uso, limites, CPF/CNPJ e token do aviso do Asaas.

const { entitlement, canStartConversation, canActivateProperty, usagePercent } = require('../src/services/billing/entitlement');
const { isValidCpf, isValidCnpj, normalizeDocument } = require('../src/services/billing/document');
const { tokenMatches } = require('../src/services/billing.service');
const { PLANS } = require('../src/config/plans');

const NOW = new Date('2026-09-25T12:00:00Z');
const H = 60 * 60 * 1000;
const at = (ms) => new Date(NOW.getTime() + ms);

describe('direito de uso', () => {
  test('conta sem assinatura = interno, sem limite', () => {
    const e = entitlement(null, NOW);
    expect(e).toMatchObject({ plan: 'interno', active: true, reason: null });
    expect(e.limits.conversations).toBeNull();
  });

  test('teste grátis vale até o último instante e avisa nos 3 dias finais', () => {
    expect(entitlement({ plan: 'teste', status: 'teste', trialEndsAt: at(10 * 24 * H) }, NOW)).toMatchObject({ active: true, warning: null, daysLeft: 10 });
    expect(entitlement({ plan: 'teste', status: 'teste', trialEndsAt: at(2 * 24 * H) }, NOW)).toMatchObject({ active: true, warning: 'teste_acabando' });
    expect(entitlement({ plan: 'teste', status: 'teste', trialEndsAt: at(0) }, NOW)).toMatchObject({ active: true }); // limite exato
    expect(entitlement({ plan: 'teste', status: 'teste', trialEndsAt: at(-1) }, NOW)).toMatchObject({ active: false, reason: 'teste_expirado' });
  });

  test('ativa atende; atrasada atende até o fim da carência e sempre avisa', () => {
    expect(entitlement({ plan: 'essencial', status: 'ativa' }, NOW)).toMatchObject({ active: true, limits: PLANS.essencial.limits });
    expect(entitlement({ plan: 'essencial', status: 'inadimplente', graceUntil: at(H) }, NOW)).toMatchObject({ active: true, warning: 'pagamento_atrasado' });
    expect(entitlement({ plan: 'essencial', status: 'inadimplente', graceUntil: at(-H) }, NOW)).toMatchObject({ active: false, reason: 'pagamento_atrasado' });
    expect(entitlement({ plan: 'essencial', status: 'inadimplente', graceUntil: null }, NOW)).toMatchObject({ active: false });
  });

  test('cancelada atende até o fim do período pago', () => {
    expect(entitlement({ plan: 'profissional', status: 'cancelada', currentPeriodEnd: at(H) }, NOW)).toMatchObject({ active: true, warning: 'assinatura_cancelada' });
    expect(entitlement({ plan: 'profissional', status: 'cancelada', currentPeriodEnd: at(-H) }, NOW)).toMatchObject({ active: false, reason: 'assinatura_cancelada' });
  });

  test('plano ou situação desconhecidos não atendem', () => {
    expect(entitlement({ plan: 'ouro', status: 'ativa' }, NOW)).toMatchObject({ active: false, reason: 'plano_desconhecido' });
    expect(entitlement({ plan: 'essencial', status: 'pausada' }, NOW)).toMatchObject({ active: false, reason: 'situacao_desconhecida' });
  });
});

describe('limites', () => {
  const ativa = entitlement({ plan: 'essencial', status: 'ativa' }, NOW);
  const limite = PLANS.essencial.limits.conversations;

  test('conversa nova: abaixo do limite passa, no limite não passa', () => {
    expect(canStartConversation(ativa, limite - 1)).toEqual({ ok: true, reason: null });
    expect(canStartConversation(ativa, limite)).toEqual({ ok: false, reason: 'limite_de_conversas' });
    expect(canStartConversation(entitlement(null, NOW), 1e9)).toEqual({ ok: true, reason: null });
  });

  test('conta sem direito: o motivo é o da assinatura, antes do limite', () => {
    const vencido = entitlement({ plan: 'teste', status: 'teste', trialEndsAt: at(-1) }, NOW);
    expect(canStartConversation(vencido, 0)).toEqual({ ok: false, reason: 'teste_expirado' });
  });

  test('imóveis ativos', () => {
    expect(canActivateProperty(ativa, PLANS.essencial.limits.properties - 1)).toBe(true);
    expect(canActivateProperty(ativa, PLANS.essencial.limits.properties)).toBe(false);
    expect(canActivateProperty(entitlement(null, NOW), 1e6)).toBe(true);
  });

  test('percentual de uso', () => {
    expect(usagePercent(0, 150)).toBe(0);
    expect(usagePercent(120, 150)).toBe(80);
    expect(usagePercent(149, 150)).toBe(99); // arredonda para baixo: 100% só no limite
    expect(usagePercent(200, 150)).toBe(100);
    expect(usagePercent(5, null)).toBeNull();
    expect(usagePercent(0, 0)).toBe(100);
  });

  test('todo plano tem os quatro limites', () => {
    for (const p of Object.values(PLANS)) {
      expect(Object.keys(p.limits).sort()).toEqual(['conversations', 'properties', 'templates', 'users']);
    }
  });
});

describe('CPF e CNPJ', () => {
  test('CPF válido com e sem pontuação; inválidos recusados', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('52998224725')).toBe(true);
    expect(isValidCpf('52998224724')).toBe(false);
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(isValidCpf('123')).toBe(false);
  });

  test('CNPJ válido com e sem pontuação; inválidos recusados', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11222333000181')).toBe(true);
    expect(isValidCnpj('11222333000182')).toBe(false);
    expect(isValidCnpj('00000000000000')).toBe(false);
  });

  test('normaliza para só dígitos ou devolve null', () => {
    expect(normalizeDocument(' 529.982.247-25 ')).toBe('52998224725');
    expect(normalizeDocument('11.222.333/0001-81')).toBe('11222333000181');
    expect(normalizeDocument('abc')).toBeNull();
    expect(normalizeDocument(null)).toBeNull();
  });
});

describe('token do aviso do Asaas', () => {
  test('compara em tempo constante e exige token configurado com 16+ caracteres', () => {
    expect(tokenMatches('token-secreto-123456', 'token-secreto-123456')).toBe(true);
    expect(tokenMatches('token-secreto-123457', 'token-secreto-123456')).toBe(false);
    expect(tokenMatches('curto', 'curto')).toBe(false);
    expect(tokenMatches(undefined, 'token-secreto-123456')).toBe(false);
    expect(tokenMatches('', '')).toBe(false);
  });
});
