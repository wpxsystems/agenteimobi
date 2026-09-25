'use strict';

/**
 * Rotinas do dono (fase 2), a cada ROUTINES_INTERVAL_MS, para cada conta ativa:
 *   1. avisos de qualidade (quality.sync)
 *   2. resumo diário depois das 8h locais (digest.runDue; uma vez por dia)
 *   3. lembretes de visita nas 24 h antes (visit.sendDueReminders)
 * Tudo é idempotente: várias instâncias podem rodar ao mesmo tempo.
 */

const logger = require('../config/logger');
const { Tenant } = require('../models');
const quality = require('../services/quality.service');
const digest = require('../services/digest.service');
const visits = require('../services/visit.service');

const ROUTINES_INTERVAL_MS = 10 * 60 * 1000;

async function runForTenant(tenant, now = new Date()) {
  const out = {};
  for (const [name, fn] of [
    ['avisos', () => quality.sync(tenant)],
    ['resumo', () => digest.runDue(tenant, now)],
    ['lembretes', () => visits.sendDueReminders(tenant, now)],
  ]) {
    try {
      out[name] = await fn();
    } catch (err) {
      logger.error({ tenantId: tenant.id, rotina: name, code: err.code, message: err.code ? undefined : err.message }, 'Falha na rotina');
    }
  }
  return out;
}

async function runOnce(now = new Date()) {
  const tenants = await Tenant.findAll({ where: { isActive: true } });
  for (const tenant of tenants) await runForTenant(tenant, now);
}

function start() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runOnce();
    } catch (err) {
      logger.error({ code: err.code }, 'Falha nas rotinas');
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(tick, 30 * 1000);
  first.unref();
  const timer = setInterval(tick, ROUTINES_INTERVAL_MS);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

module.exports = { start, runOnce, runForTenant };
