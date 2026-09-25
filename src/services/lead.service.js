'use strict';

const { Op } = require('sequelize');
const inTx = require('../db/inTx');
const AppError = require('../errors/AppError');
const { Lead, Message, Property } = require('../models');
const conversation = require('./conversation.service');
const { describeQualification } = require('./scoring');

async function list(tenantId, { classification, status, propertyId, limit, offset }) {
  const where = {};
  if (classification) where.classification = classification;
  if (status) where.status = status;
  if (propertyId) where.propertyId = propertyId;
  return inTx(tenantId, (t) =>
    Lead.findAndCountAll({
      where,
      include: [{ model: Property, as: 'property', attributes: ['id', 'code', 'title'] }],
      order: [['updatedAt', 'DESC']],
      limit,
      offset,
      transaction: t,
    })
  );
}

async function get(tenantId, id) {
  const result = await inTx(tenantId, async (t) => {
    const lead = await Lead.findByPk(id, {
      include: [{ model: Property, as: 'property', attributes: ['id', 'code', 'title'] }],
      transaction: t,
    });
    if (!lead) return null;
    const messages = await Message.findAll({ where: { leadId: id }, order: [['createdAt', 'ASC']], limit: 500, transaction: t });
    return { lead, messages };
  });
  if (!result) throw AppError.notFound('Lead');
  return result;
}

async function update(tenantId, id, data) {
  return inTx(tenantId, async (t) => {
    const lead = await Lead.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!lead) throw AppError.notFound('Lead');
    if (lead.anonymizedAt) throw new AppError('LEAD_ANONYMIZED', 'Os dados deste lead foram excluídos', 409);
    if (lead.status === 'opt_out') throw new AppError('LEAD_OPT_OUT', 'Lead pediu para não receber mensagens', 409);

    const patch = { ...data };
    // Religar o bot devolve o lead ao atendimento automático.
    if (data.botActive === true && !data.status && lead.status === 'transferido') patch.status = 'em_atendimento';
    if (data.status === 'transferido' && !lead.handoffAt) patch.handoffAt = new Date();
    // Transferência manual pelo painel: garante um resumo para quem assume, mesmo sem a IA.
    if (data.status === 'transferido' && !lead.handoffSummary) {
      const property = lead.propertyId ? await Property.findByPk(lead.propertyId, { transaction: t }) : null;
      patch.handoffSummary = describeQualification({
        name: lead.displayName,
        property: property && property.get({ plain: true }),
        qualification: lead.qualification,
        visitPreference: lead.visitPreference,
        classification: lead.classification,
      });
    }
    return lead.update(patch, { transaction: t });
  });
}

/** Leads para exportação: mesmos filtros do funil (imóvel e período de criação), até 10.000 linhas. */
async function listForExport(tenantId, { propertyId, from, to }) {
  const where = {};
  if (propertyId) where.propertyId = propertyId;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt[Op.gte] = new Date(from);
    if (to) where.createdAt[Op.lt] = new Date(to);
  }
  return inTx(tenantId, (t) =>
    Lead.findAll({
      where,
      include: [{ model: Property, as: 'property', attributes: ['id', 'code', 'title'] }],
      order: [['createdAt', 'DESC']],
      limit: 10000,
      transaction: t,
    })
  );
}

async function sendMessage(tenantId, id, text) {
  const res = await conversation.sendHumanMessage(tenantId, id, text);
  if (!res) throw AppError.notFound('Lead');
  if (res.error === 'ANONYMIZED') throw new AppError('LEAD_ANONYMIZED', 'Os dados deste lead foram excluídos', 409);
  if (res.error === 'OPT_OUT') throw new AppError('LEAD_OPT_OUT', 'Lead pediu para não receber mensagens', 409);
  if (res.error === 'WINDOW_CLOSED') {
    throw new AppError('WA_WINDOW_CLOSED', 'Passou a janela de 24h do WhatsApp; só é possível enviar template aprovado', 409);
  }
}

module.exports = { list, get, update, sendMessage, listForExport };
