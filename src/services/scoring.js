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

/**
 * Imóveis ativos compatíveis com o que o lead já disse, excluindo o atual.
 * Compatível = scoreLead sem motivo de desqualificação. Ordena por score (desc) e preço (asc).
 * Função pura: recebe objetos planos e devolve os imóveis escolhidos.
 */
function findAlternatives(qualification = {}, properties = [], currentId = null, max = 3) {
  return properties
    .filter((p) => p && p.isActive !== false && p.id !== currentId)
    .map((p) => ({ property: p, ...scoreLead(qualification, p) }))
    .filter((r) => r.disqualifyReasons.length === 0)
    .sort((a, b) => b.score - a.score || Number(a.property.priceCents) - Number(b.property.priceCents))
    .slice(0, max)
    .map((r) => r.property);
}

const MAX_OPEN_QUESTIONS = 10;

/**
 * Junta as dúvidas sem resposta já registradas com as novas desta rodada.
 * Normaliza espaços, ignora duplicadas (sem diferenciar maiúsculas) e mantém no máximo MAX_OPEN_QUESTIONS.
 */
function mergeOpenQuestions(current = [], extracted = []) {
  const out = [];
  const seen = new Set();
  for (const raw of [...(Array.isArray(current) ? current : []), ...(Array.isArray(extracted) ? extracted : [])]) {
    const q = String(raw || '').replace(/\s+/g, ' ').trim();
    if (q.length < 3) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q.slice(0, 200));
  }
  return out.slice(-MAX_OPEN_QUESTIONS);
}

const GUARANTEE_LABEL = {
  fiador: 'fiador',
  caucao: 'caução',
  seguro_fianca: 'seguro-fiança',
  titulo_capitalizacao: 'título de capitalização',
  sem_garantia: 'sem garantia',
};
const CLASS_LABEL = { quente: 'quente', morno: 'morno', frio: 'frio', indefinido: 'ainda qualificando' };
const brl = (cents) => (Number(cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Resumo determinístico para o corretor, usado quando a IA não mandou o dela
 * (ex.: transferência automática por "quente + preferência de visita").
 */
function describeQualification({ name, property, qualification = {}, visitPreference, classification }) {
  const q = qualification;
  const partes = [];
  partes.push(`${name || 'Lead sem nome'}: interesse em ${property ? `#${property.code} (${property.title})` : 'imóvel não definido'}, classificação ${CLASS_LABEL[classification] || classification}.`);
  const fatos = [];
  if (isKnown(q.monthlyIncomeCents)) fatos.push(`renda ${brl(q.monthlyIncomeCents)}`);
  if (isKnown(q.guarantee)) fatos.push(`garantia ${GUARANTEE_LABEL[q.guarantee] || q.guarantee}`);
  if (isKnown(q.occupants)) fatos.push(`${q.occupants} morador${q.occupants === 1 ? '' : 'es'}`);
  if (isKnown(q.hasPets)) fatos.push(q.hasPets ? 'tem pet' : 'sem pet');
  if (isKnown(q.moveInDays)) fatos.push(`mudança em ${q.moveInDays} dias`);
  if (fatos.length) partes.push(`Informou: ${fatos.join(', ')}.`);
  if (visitPreference) partes.push(`Quer visitar: ${visitPreference}.`);
  else if (q.wantsVisit === true) partes.push('Quer visitar, sem dia definido.');
  return partes.join(' ');
}

module.exports = {
  scoreLead,
  mergeQualification,
  findAlternatives,
  mergeOpenQuestions,
  describeQualification,
  GUARANTEES,
  RULES,
  KEY_FACTS,
  MAX_OPEN_QUESTIONS,
};
