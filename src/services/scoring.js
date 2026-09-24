'use strict';

/**
 * Classificação do lead — CALCULADA NO BACKEND.
 * A IA só extrai fatos da conversa (renda, garantia, moradores...). Quem decide se o lead é
 * quente/morno/frio é esta função pura, determinística e testável. Assim a regra não depende
 * do humor do modelo e não pode ser "convencida" pelo lead via prompt.
 *
 * Valores monetários sempre em centavos (inteiros).
 */

const GUARANTEES = ['fiador', 'caucao', 'seguro_fianca', 'titulo_capitalizacao', 'sem_garantia'];

const RULES = Object.freeze({
  INCOME_MIN_RATIO: 2.5, // abaixo disso: desqualifica
  INCOME_GOOD_RATIO: 3, // regra de mercado: renda >= 3x o custo mensal
  HOT_SCORE: 70,
  WARM_SCORE: 40,
  MIN_KNOWN_FACTS: 3, // abaixo disso ainda está "indefinido" (qualificando)
});

const KEY_FACTS = ['monthlyIncomeCents', 'guarantee', 'occupants', 'hasPets', 'moveInDays'];

const isKnown = (v) => v !== null && v !== undefined;

/**
 * @param {object} q  qualificação acumulada do lead
 * @param {object} p  imóvel { dealType, priceCents, feesCents, allowsPets, maxOccupants, acceptedGuarantees }
 * @returns {{ score: number, classification: string, disqualifyReasons: string[], knownFacts: number }}
 */
function scoreLead(q = {}, p = null) {
  const reasons = [];
  let score = 0;

  if (!p) {
    // Sem imóvel definido não há como comparar: segue qualificando.
    return { score: 0, classification: 'indefinido', disqualifyReasons: [], knownFacts: 0 };
  }

  const isRent = p.dealType !== 'venda';
  const monthlyCost = Number(p.priceCents) + Number(p.feesCents || 0);
  const knownFacts = KEY_FACTS.filter((k) => isKnown(q[k])).length;

  // ---- Renda x custo mensal (só aluguel) ----
  if (isRent && isKnown(q.monthlyIncomeCents) && monthlyCost > 0) {
    const ratio = q.monthlyIncomeCents / monthlyCost;
    if (ratio < RULES.INCOME_MIN_RATIO) reasons.push('renda_insuficiente');
    else if (ratio >= RULES.INCOME_GOOD_RATIO) score += 30;
    else score += 15;
  }

  // ---- Garantia (só aluguel) ----
  if (isRent && isKnown(q.guarantee)) {
    const accepted = p.acceptedGuarantees || [];
    if (accepted.length === 0 || accepted.includes(q.guarantee)) score += 20;
    else reasons.push('garantia_nao_aceita');
  }

  // ---- Pets ----
  if (isKnown(q.hasPets)) {
    if (q.hasPets === true && p.allowsPets === false) reasons.push('pet_nao_permitido');
    else score += 5;
  }

  // ---- Moradores ----
  if (isKnown(q.occupants)) {
    if (isKnown(p.maxOccupants) && q.occupants > p.maxOccupants) reasons.push('moradores_acima_limite');
    else score += 5;
  }

  // ---- Prazo de mudança ----
  if (isKnown(q.moveInDays)) {
    if (q.moveInDays <= 30) score += 20;
    else if (q.moveInDays <= 60) score += 10;
  }

  // ---- Interesse em visitar ----
  if (q.wantsVisit === true) score += 20;

  let classification;
  if (reasons.length > 0) classification = 'frio';
  else if (score >= RULES.HOT_SCORE) classification = 'quente';
  else if (knownFacts < RULES.MIN_KNOWN_FACTS) classification = 'indefinido';
  else if (score >= RULES.WARM_SCORE) classification = 'morno';
  else classification = 'frio';

  return { score, classification, disqualifyReasons: reasons, knownFacts };
}

/**
 * Mescla fatos novos extraídos pela IA na qualificação acumulada.
 * Só sobrescreve quando o novo valor é conhecido (a IA não "esquece" o que já foi dito).
 */
function mergeQualification(current = {}, extracted = {}) {
  const out = { ...current };
  for (const [k, v] of Object.entries(extracted)) {
    if (isKnown(v)) out[k] = v;
  }
  return out;
}

module.exports = { scoreLead, mergeQualification, GUARANTEES, RULES, KEY_FACTS };
