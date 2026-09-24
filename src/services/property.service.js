'use strict';

const { UniqueConstraintError } = require('sequelize');
const env = require('../config/env');
const inTx = require('../db/inTx');
const AppError = require('../errors/AppError');
const { Tenant, Property, LinkClick } = require('../models');

async function list(tenantId) {
  return inTx(tenantId, (t) => Property.findAll({ order: [['createdAt', 'DESC']], transaction: t }));
}

async function get(tenantId, id) {
  const p = await inTx(tenantId, (t) => Property.findByPk(id, { transaction: t }));
  if (!p) throw AppError.notFound('Imóvel');
  return p;
}

async function create(tenantId, data) {
  try {
    return await inTx(tenantId, (t) => Property.create({ ...data, tenantId }, { transaction: t }));
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw AppError.conflict('Já existe imóvel com esse código');
    throw err;
  }
}

async function update(tenantId, id, data) {
  try {
    return await inTx(tenantId, async (t) => {
      const p = await Property.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
      if (!p) throw AppError.notFound('Imóvel');
      return p.update(data, { transaction: t });
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw AppError.conflict('Já existe imóvel com esse código');
    throw err;
  }
}

/** Mensagem pré-preenchida carrega o código -> o webhook vincula o lead ao imóvel. */
function buildWaLink(waDisplayPhone, property) {
  const text = `Olá! Tenho interesse no imóvel #${property.code} (${property.title}).`;
  return `https://wa.me/${waDisplayPhone}?text=${encodeURIComponent(text)}`;
}

function buildTrackedLink(slug, code, src) {
  const base = `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/r/${slug}/${code}`;
  return src ? `${base}?src=${encodeURIComponent(src)}` : base;
}

async function links(tenantId, id, src) {
  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant?.waDisplayPhone) {
    throw new AppError('WA_NOT_CONFIGURED', 'Número de WhatsApp da conta não configurado', 409);
  }
  const property = await get(tenantId, id);
  return {
    waLink: buildWaLink(tenant.waDisplayPhone, property),
    trackedLink: buildTrackedLink(tenant.slug, property.code, src || 'marketplace'),
  };
}

/**
 * Link público rastreado: conta o clique e devolve o destino do WhatsApp.
 * Não guarda IP nem user-agent (minimização LGPD) — só data, imóvel e origem.
 */
async function registerClick(slug, code, src) {
  const tenant = await Tenant.findOne({ where: { slug, isActive: true } });
  if (!tenant?.waDisplayPhone) return null;
  return inTx(tenant.id, async (t) => {
    const property = await Property.findOne({ where: { code, isActive: true }, transaction: t });
    if (!property) return null;
    await LinkClick.create(
      { tenantId: tenant.id, propertyId: property.id, source: src || null },
      { transaction: t }
    );
    return buildWaLink(tenant.waDisplayPhone, property);
  });
}

module.exports = { list, get, create, update, links, registerClick, buildWaLink, buildTrackedLink };
