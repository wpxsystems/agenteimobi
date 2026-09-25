'use strict';

/**
 * Planos e limites.
 *
 * ⚠️ PREÇOS E LIMITES PROVISÓRIOS. Definir com base no custo real medido em aim_usage_month
 * (chamadas à IA e templates por conta) antes de vender. Mudar aqui não altera assinaturas já
 * criadas no provedor de cobrança: o valor delas muda só no próximo checkout.
 *
 *   conversations : leads diferentes atendidos pela IA no mês (fuso de São Paulo)
 *   properties    : imóveis ATIVOS ao mesmo tempo
 *   users         : pessoas com acesso ao painel (ainda sem tela de convite)
 *   templates     : templates pagos da Meta por mês (reativação, lembretes)
 *   null          = sem limite
 */

const TRIAL_DAYS = 14;
/** Dias em que a conta com pagamento atrasado continua atendendo antes de parar. */
const GRACE_DAYS = 5;

const PLANS = {
  teste: {
    name: 'Teste grátis',
    priceCents: 0,
    purchasable: false,
    limits: { conversations: 30, properties: 3, users: 1, templates: 0 },
  },
  essencial: {
    name: 'Essencial',
    priceCents: 19700, // PROVISÓRIO
    purchasable: true,
    description: 'Para o corretor autônomo ou a imobiliária pequena.',
    limits: { conversations: 150, properties: 20, users: 2, templates: 200 },
  },
  profissional: {
    name: 'Profissional',
    priceCents: 49700, // PROVISÓRIO
    purchasable: true,
    description: 'Para a imobiliária com vários corretores e mais anúncios.',
    limits: { conversations: 600, properties: 100, users: 10, templates: 1000 },
  },
  // Contas criadas antes dos planos, pelo seed ou à mão: sem limite, sem cobrança.
  interno: {
    name: 'Interno',
    priceCents: 0,
    purchasable: false,
    limits: { conversations: null, properties: null, users: null, templates: null },
  },
};

const PURCHASABLE = Object.keys(PLANS).filter((k) => PLANS[k].purchasable);

module.exports = { PLANS, PURCHASABLE, TRIAL_DAYS, GRACE_DAYS };
