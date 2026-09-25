'use strict';

/**
 * Worker da fila de jobs (aim_job).
 *
 * A cada JOB_POLL_MS (ou na hora, quando um job novo é gravado neste processo) reivindica até
 * JOB_CONCURRENCY - em_andamento jobs e roda cada um sem esperar os outros: uma resposta da IA
 * demorada não segura as mensagens recebidas de outros leads.
 *
 * Erro no job -> job.service.fail (nova tentativa com espera, ou 'falhou').
 * Vários processos podem rodar o worker ao mesmo tempo: a reivindicação usa SKIP LOCKED.
 */

const env = require('../config/env');
const logger = require('../config/logger');
const jobs = require('../services/job.service');
const { Tenant } = require('../models');
const conversation = require('../services/conversation.service');

const PURGE_EVERY_MS = 10 * 60 * 1000;

const handlers = {
  async inbound(job, row) {
    await conversation.handleInbound(row.payload, job.tenantId);
  },
  async reply(job, row) {
    const tenant = await Tenant.findByPk(job.tenantId);
    if (!tenant || !tenant.isActive) return; // conta desativada: descarta
    await conversation.processReply(tenant, row.leadId);
  },
};

function createWorker({ concurrency = env.JOB_CONCURRENCY, pollMs = env.JOB_POLL_MS } = {}) {
  let inFlight = 0;
  let claiming = false;
  let again = false;
  let stopped = true;
  let timer = null;
  let lastPurge = 0;
  const idleWaiters = [];

  function notifyIdle() {
    if (inFlight === 0 && !claiming) idleWaiters.splice(0).forEach((resolve) => resolve());
  }

  async function runJob(job) {
    try {
      const row = await jobs.load(job);
      if (!row) return; // outro processo já fechou este job
      const handler = handlers[job.kind];
      if (!handler) throw Object.assign(new Error('Tipo de job desconhecido'), { code: 'JOB_UNKNOWN_KIND' });
      await handler(job, row);
      await jobs.complete(job);
    } catch (err) {
      const outcome = await jobs.fail(job, err).catch((e) => {
        logger.error({ jobId: job.id, code: e.code }, 'Falha ao registrar erro do job');
        return 'unknown';
      });
      logger.error({ jobId: job.id, kind: job.kind, code: err.code, outcome }, 'Job falhou');
    }
  }

  async function maybePurge() {
    if (Date.now() - lastPurge < PURGE_EVERY_MS) return;
    lastPurge = Date.now();
    try {
      const n = await jobs.purge();
      if (n) logger.info({ removed: n }, 'Limpeza da fila de jobs');
    } catch (err) {
      logger.error({ code: err.code }, 'Falha na limpeza da fila de jobs');
    }
  }

  async function tick() {
    if (stopped) return;
    if (claiming) {
      again = true; // chegou job novo durante a reivindicação: roda de novo em seguida
      return;
    }
    const free = concurrency - inFlight;
    if (free <= 0) return;
    claiming = true;
    let claimed = [];
    try {
      claimed = await jobs.claim(free);
    } catch (err) {
      logger.error({ code: err.code }, 'Falha ao reivindicar jobs');
    } finally {
      claiming = false;
    }
    for (const job of claimed) {
      inFlight += 1;
      runJob(job).finally(() => {
        inFlight -= 1;
        notifyIdle();
        tick();
      });
    }
    notifyIdle();
    if (again || (claimed.length === free && free > 0)) {
      again = false;
      setImmediate(tick);
    }
    maybePurge();
  }

  const onEnqueued = () => tick();

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      jobs.events.on('enqueued', onEnqueued);
      timer = setInterval(tick, pollMs);
      timer.unref();
      tick();
    },
    /** Para de reivindicar e espera os jobs em andamento terminarem (até `timeoutMs`). */
    async stop(timeoutMs = 8000) {
      stopped = true;
      clearInterval(timer);
      jobs.events.off('enqueued', onEnqueued);
      if (inFlight === 0 && !claiming) return;
      await Promise.race([
        new Promise((resolve) => idleWaiters.push(resolve)),
        new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
      ]);
    },
    /** Resolve quando não há job em andamento neste processo (usado nos testes). */
    idle() {
      if (inFlight === 0 && !claiming) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    tick,
  };
}

module.exports = { createWorker, handlers };
