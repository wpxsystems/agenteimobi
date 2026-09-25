'use strict';

/**
 * Direitos do titular e retenção (item 1.5 do plano). Ver docs/lgpd/.
 *
 *   exportLead     : cópia dos dados de um lead (acesso/portabilidade, Art. 18, II e V)
 *   anonymizeLead  : exclusão a pedido (Art. 18, VI) ou pela retenção. Apaga mensagens e textos,
 *                    troca o telefone por um número fictício e mantém só o que alimenta os números do funil.
 *   runRetention   : anonimiza leads sem conversa há mais de retention_months e limpa links/sessões vencidos.
 *   deleteAccount  : a conta inteira some (cascata no banco), depois de cancelar a cobrança.
 *
 * Os pedidos manuais ficam em aim_privacy_request com o HASH do telefone, nunca o telefone.
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { QueryTypes } = require('sequelize');
const env = require('../config/env');
const logger = require('../config/logger');
const inTx = require('../db/inTx');
const AppError = require('../errors/AppError');
const { sequelize, Tenant, User, Lead, Message, Property } = require('../models');
const asaas = require('./billing/asaas');

const subjectRef = (tenantId, waId) => crypto.createHash('sha256').update(`${tenantId}:${waId}`, 'utf8').digest('hex');

/** Número fictício que respeita o formato do campo (15 dígitos) e não é um telefone real: começa com 000. */
const fakeWaId = () => `000${crypto.randomInt(0, 1e12).toString().padStart(12, '0')}`;

async function logRequest(t, { tenantId, kind, waId, userId }) {
  await sequelize.query(
    `INSERT INTO aim_privacy_request (tenant_id, kind, subject_ref, requested_by) VALUES (:tenantId, :kind, :ref, :userId)`,
    { replacements: { tenantId, kind, ref: subjectRef(tenantId, waId), userId: userId || null }, transaction: t }
  );
}

/** Cópia legível dos dados de um lead, com a conversa. */
async function exportLead(tenantId, leadId, userId) {
  return inTx(tenantId, async (t) => {
    const lead = await Lead.findByPk(leadId, { transaction: t });
    if (!lead) throw AppError.notFound('Lead');
    if (lead.anonymizedAt) throw new AppError('LEAD_ANONYMIZED', 'Os dados deste lead já foram excluídos', 409);
    const property = lead.propertyId ? await Property.findByPk(lead.propertyId, { transaction: t }) : null;
    const messages = await Message.findAll({ where: { leadId }, order: [['createdAt', 'ASC']], transaction: t });
    await logRequest(t, { tenantId, kind: 'exportacao', waId: lead.waId, userId });
    const q = lead.qualification || {};
    return {
      geradoEm: new Date().toISOString(),
      titular: { telefone: lead.waId, nome: lead.displayName },
      atendimento: {
        imovel: property ? `${property.code} - ${property.title}` : null,
        origem: lead.source,
        situacao: lead.status,
        classificacao: lead.classification,
        informouAoAtendimento: {
          rendaMensalReais: q.monthlyIncomeCents === undefined || q.monthlyIncomeCents === null ? null : q.monthlyIncomeCents / 100,
          garantia: q.guarantee ?? null,
          moradores: q.occupants ?? null,
          temPet: q.hasPets ?? null,
          prazoMudancaDias: q.moveInDays ?? null,
          querVisitar: q.wantsVisit ?? null,
          preferenciaDeVisita: lead.visitPreference,
        },
        resumoParaCorretor: lead.handoffSummary,
        duvidasRegistradas: lead.openQuestions || [],
        avisoDePrivacidadeEnviadoEm: lead.privacyNoticeSentAt,
        pediuParaNaoReceberEm: lead.optOutAt,
        primeiroContato: lead.createdAt,
      },
      conversa: messages.map((m) => ({ em: m.createdAt, de: m.direction === 'in' ? 'lead' : m.author === 'human' ? 'corretor' : 'assistente', texto: m.body })),
    };
  });
}

/** Anonimiza um lead dentro de uma transação da conta. Idempotente. */
async function anonymizeInTx(t, lead) {
  if (lead.anonymizedAt) return false;
  const oldWaId = lead.waId;
  await Message.destroy({ where: { leadId: lead.id }, transaction: t });
  // Jobs com o texto do lead (a fila já apaga em 24 h; aqui sai na hora).
  await sequelize.query(`DELETE FROM aim_job WHERE lead_id = :id OR serial_key = :key`, {
    replacements: { id: lead.id, key: `in:${oldWaId}` },
    transaction: t,
  });
  await lead.update(
    {
      waId: fakeWaId(),
      displayName: null,
      qualification: {},
      disqualifyReasons: [],
      visitPreference: null,
      handoffReason: null,
      handoffSummary: null,
      openQuestions: [],
      botActive: false,
      status: lead.status === 'opt_out' ? 'opt_out' : 'descartado',
      anonymizedAt: new Date(),
    },
    { transaction: t }
  );
  return oldWaId;
}

/** Exclusão a pedido do titular (admin). */
async function anonymizeLead(tenantId, leadId, userId) {
  await inTx(tenantId, async (t) => {
    const lead = await Lead.findByPk(leadId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!lead) throw AppError.notFound('Lead');
    const oldWaId = await anonymizeInTx(t, lead);
    if (oldWaId) await logRequest(t, { tenantId, kind: 'exclusao', waId: oldWaId, userId });
  });
  logger.info({ tenantId, leadId }, 'Lead anonimizado a pedido');
}

/**
 * Retenção de uma conta: anonimiza leads sem conversa há mais de retention_months (até 500 por vez)
 * e apaga links de uso único e sessões vencidos há mais de 30 dias.
 * @returns {Promise<{ leads: number, tokens: number, sessions: number }>}
 */
async function runRetention(tenant) {
  const months = tenant.retentionMonths || 12;
  return inTx(tenant.id, async (t) => {
    const stale = await Lead.findAll({
      where: sequelize.literal(
        `anonymized_at IS NULL AND GREATEST(created_at, COALESCE(last_inbound_at, created_at), COALESCE(last_outbound_at, created_at)) < now() - make_interval(months => ${Number(months)})`
      ),
      limit: 500,
      lock: t.LOCK.UPDATE,
      skipLocked: true,
      transaction: t,
    });
    for (const lead of stale) await anonymizeInTx(t, lead);
    const [, tok] = await sequelize.query(
      `DELETE FROM aim_user_token WHERE (used_at IS NOT NULL OR expires_at < now()) AND updated_at < now() - interval '30 days'`,
      { transaction: t }
    );
    const [, ses] = await sequelize.query(
      `DELETE FROM aim_refresh_token WHERE (revoked_at IS NOT NULL OR expires_at < now()) AND updated_at < now() - interval '30 days'`,
      { transaction: t }
    );
    return { leads: stale.length, tokens: tok?.rowCount || 0, sessions: ses?.rowCount || 0 };
  });
}

/** Prazo de guarda das conversas da conta (admin). */
async function setRetention(tenantId, months) {
  await inTx(tenantId, (t) =>
    sequelize.query('UPDATE aim_tenant SET retention_months = :months, updated_at = now() WHERE id = :tenantId', {
      replacements: { months, tenantId },
      transaction: t,
    })
  );
}

/**
 * Exclui a conta inteira. Exige a senha do admin e o endereço da conta digitado.
 * Cancela a assinatura no provedor ANTES: se o cancelamento falhar, nada é apagado (não cobrar conta excluída).
 */
async function deleteAccount(tenantId, userId, { password, slug }) {
  const ctx = await inTx(tenantId, async (t) => {
    const tenant = await Tenant.findByPk(tenantId, { transaction: t });
    const user = await User.scope('withPassword').findByPk(userId, { transaction: t });
    const [sub] = await sequelize.query(
      'SELECT provider, provider_subscription_id AS "providerSubscriptionId" FROM aim_subscription',
      { type: QueryTypes.SELECT, transaction: t }
    );
    return { tenant, user, sub };
  });
  if (!ctx.tenant || !ctx.user) throw AppError.unauthorized();
  const passwordOk = await bcrypt.compare(password, ctx.user.passwordHash);
  if (!passwordOk || slug !== ctx.tenant.slug) {
    throw new AppError('CONFIRMATION_FAILED', 'Senha ou endereço da conta não conferem', 403);
  }
  if (ctx.sub && ctx.sub.provider === 'asaas' && ctx.sub.providerSubscriptionId && env.BILLING_PROVIDER === 'asaas') {
    await asaas.cancelSubscription(ctx.sub.providerSubscriptionId);
  }
  await inTx(tenantId, (t) => sequelize.query('DELETE FROM aim_tenant WHERE id = :tenantId', { replacements: { tenantId }, transaction: t }));
  logger.warn({ tenantId }, 'Conta excluída pelo administrador');
}

module.exports = { exportLead, anonymizeLead, runRetention, setRetention, deleteAccount, subjectRef, fakeWaId };
