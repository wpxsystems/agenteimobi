'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const env = require('../../config/env');
const logger = require('../../config/logger');
const AppError = require('../../errors/AppError');
const { GUARANTEES } = require('../scoring');

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 30000, maxRetries: 2 });

const TOOL_NAME = 'registrar_atendimento';

// JSON Schema enviado ao modelo.
const TOOL = {
  name: TOOL_NAME,
  description: 'Registra a resposta a ser enviada ao lead no WhatsApp e os fatos de qualificação extraídos da conversa.',
  input_schema: {
    type: 'object',
    properties: {
      resposta: { type: 'string', description: 'Mensagem a enviar ao lead. Curta, estilo WhatsApp.' },
      fatos: {
        type: 'object',
        properties: {
          renda_mensal_reais: { type: ['number', 'null'], description: 'Renda mensal em reais, se informada.' },
          garantia: { type: ['string', 'null'], enum: [...GUARANTEES, null] },
          moradores: { type: ['integer', 'null'] },
          tem_pet: { type: ['boolean', 'null'] },
          prazo_mudanca_dias: { type: ['integer', 'null'], description: 'Em quantos dias pretende se mudar.' },
          quer_visitar: { type: ['boolean', 'null'] },
        },
        required: ['renda_mensal_reais', 'garantia', 'moradores', 'tem_pet', 'prazo_mudanca_dias', 'quer_visitar'],
      },
      codigo_imovel: { type: ['string', 'null'], description: 'Código do imóvel de interesse, sem #, se identificado.' },
      preferencia_visita: { type: ['string', 'null'], description: 'Dia/período preferido para visita, se informado.' },
      proxima_acao: { type: 'string', enum: ['continuar', 'propor_visita', 'transferir_humano', 'encerrar'] },
      motivo_transferencia: { type: ['string', 'null'] },
    },
    required: ['resposta', 'fatos', 'codigo_imovel', 'preferencia_visita', 'proxima_acao', 'motivo_transferencia'],
  },
};

// Saída do modelo é NÃO confiável: validar tudo.
const outputSchema = z.object({
  resposta: z.string().trim().min(1).max(1500),
  fatos: z.object({
    renda_mensal_reais: z.number().nonnegative().max(10_000_000).nullable().optional(),
    garantia: z.enum(GUARANTEES).nullable().optional(),
    moradores: z.number().int().min(1).max(50).nullable().optional(),
    tem_pet: z.boolean().nullable().optional(),
    prazo_mudanca_dias: z.number().int().min(0).max(3650).nullable().optional(),
    quer_visitar: z.boolean().nullable().optional(),
  }),
  codigo_imovel: z.string().regex(/^#?[A-Za-z0-9]{3,12}$/).nullable().optional(),
  preferencia_visita: z.string().max(200).nullable().optional(),
  proxima_acao: z.enum(['continuar', 'propor_visita', 'transferir_humano', 'encerrar']),
  motivo_transferencia: z.string().max(300).nullable().optional(),
});

/**
 * Converte o histórico em mensagens alternadas user/assistant, começando por user.
 * lead -> user; bot/human/system -> assistant.
 */
function toClaudeMessages(history) {
  const merged = [];
  for (const m of history) {
    const role = m.author === 'lead' ? 'user' : 'assistant';
    const text = (m.body || '').trim() || (m.author === 'lead' ? `[${m.msgType} sem texto]` : '');
    if (!text) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === role) last.content += `\n${text}`;
    else merged.push({ role, content: text });
  }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  return merged;
}

/** Mapeia a saída validada para o formato interno (camelCase, dinheiro em centavos). */
function toInternal(o) {
  const f = o.fatos || {};
  const reais = f.renda_mensal_reais;
  return {
    reply: o.resposta,
    facts: {
      monthlyIncomeCents: reais === null || reais === undefined ? null : Math.round(reais * 100),
      guarantee: f.garantia ?? null,
      occupants: f.moradores ?? null,
      hasPets: f.tem_pet ?? null,
      moveInDays: f.prazo_mudanca_dias ?? null,
      wantsVisit: f.quer_visitar ?? null,
    },
    propertyCode: o.codigo_imovel ? o.codigo_imovel.replace('#', '').toUpperCase() : null,
    visitPreference: o.preferencia_visita ?? null,
    nextAction: o.proxima_acao,
    handoffReason: o.motivo_transferencia ?? null,
  };
}

async function runTurn({ system, history }) {
  const messages = toClaudeMessages(history);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    throw new AppError('AI_NOTHING_TO_ANSWER', 'Não há mensagem do lead para responder', 500);
  }

  const res = await client.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 1024,
    system,
    messages,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL_NAME },
  });

  const block = res.content.find((b) => b.type === 'tool_use' && b.name === TOOL_NAME);
  const parsed = outputSchema.safeParse(block?.input);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues.map((i) => i.path.join('.')) }, 'Saída da IA inválida');
    throw new AppError('AI_INVALID_OUTPUT', 'Resposta da IA fora do formato', 502);
  }
  return toInternal(parsed.data);
}

module.exports = { runTurn, toClaudeMessages, toInternal, outputSchema, TOOL };
