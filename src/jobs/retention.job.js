'use strict';

/**
 * Retenção (LGPD): a cada RETENTION_INTERVAL_MS, para cada conta ativa, anonimiza leads sem conversa
 * há mais de retention_months e apaga links de uso único e sessões vencidos. Ver privacy.service.runRetention.
 * Roda em todas as instâncias sem conflito: os leads são travados com SKIP LOCKED e a anonimização é idempotente.
 */

const logger = require('../config/logger');
const { Tenant } = require('../models');
const privacy = require('../services/privacy.service');

const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function runOnce() {
  const tenants = await Tenant.findAll({ where: { isActive: true } });
  for (const tenant of tenants) {
    try {
      const r = await privacy.runRetention(tenant);
      if (r.leads || r.tokens || r.sessions) logger.info({ tenantId: tenant.id, ...r }, 'Retenção aplicada');
    } catch (err) {
      logger.error({ tenantId: tenant.id, code: err.code }, 'Falha na retenção');
    }
  }
}

function start() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runOnce();
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(tick, 60 * 1000); // um minuto depois de subir
  first.unref();
  const timer = setInterval(tick, RETENTION_INTERVAL_MS);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

module.exports = { start, runOnce };
