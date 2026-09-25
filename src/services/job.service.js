'use strict';

/**
 * Fila de jobs no banco (aim_job). Ver migration 0003 e docs/logica/fila-jobs.md.
 *
 *   enqueueInbound : mensagem recebida do webhook, gravada ANTES do 200.
 *   enqueueReply   : resposta da IA com debounce. Uma pendente por lead; mensagem nova empurra o run_at.
 *   claim          : reivindica jobs prontos de todas as contas (função SECURITY DEFINER).
 *   load/complete/fail : leitura e fechamento do job dentro do contexto da conta (RLS).
 *
 * `events` avisa o worker local que há job novo, para não esperar o próximo ciclo.
 */

const { EventEmitter } = require('events');
const { QueryTypes } = require('sequelize');
const env = require('../config/env');
const inTx = require('../db/inTx');
const { sequelize } = require('../models');
const quality = require('./quality.service');

const events = new EventEmitter();

const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 10 * 60 * 1000;

/** Espera antes da próxima tentativa: 5 s, 10 s, 20 s... até 10 min. `attempts` já inclui a tentativa que falhou. */
function retryDelayMs(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_MAX_MS);
}

/** Código curto do erro para last_error. Nunca a mensagem inteira (pode carregar dado do lead). */
function errorLabel(err) {
  const code = err && typeof err.code === 'string' ? err.code : 'ERRO';
  const name = err && err.name && err.name !== 'Error' ? err.name : '';
  return `${code}${name ? ` (${name})` : ''}`.slice(0, 200);
}

/**
 * Grava a mensagem normalizada do webhook como job. Precisa da conta já resolvida.
 * Pode ser chamada dentro de uma transação existente (t) ou abre a própria.
 */
async function enqueueInbound(tenantId, msg, t) {
  const run = (tx) =>
    sequelize.query(
      `INSERT INTO aim_job (tenant_id, kind, serial_key, payload, max_attempts)
       VALUES (:tenantId, 'inbound', :key, CAST(:payload AS jsonb), :max)`,
      {
        replacements: { tenantId, key: `in:${msg.waId}`, payload: JSON.stringify(msg), max: env.JOB_MAX_ATTEMPTS },
        transaction: tx,
      }
    );
  if (t) await run(t);
  else await inTx(tenantId, run);
  events.emit('enqueued');
}

/**
 * Agenda a resposta da IA para daqui a `delayMs`.
 *   mode 'debounce' (mensagem nova): se já houver pendente, empurra o run_at.
 *   mode 'recover' (job de recuperação): se já houver pendente, não mexe.
 */
async function enqueueReply(tenantId, leadId, { delayMs = env.REPLY_DEBOUNCE_MS, mode = 'debounce' } = {}) {
  const onConflict =
    mode === 'recover' ? 'DO NOTHING' : 'DO UPDATE SET run_at = EXCLUDED.run_at, updated_at = now()';
  await inTx(tenantId, (t) =>
    sequelize.query(
      `INSERT INTO aim_job (tenant_id, kind, lead_id, serial_key, run_at, max_attempts)
       VALUES (:tenantId, 'reply', :leadId, :key, now() + make_interval(secs => :delaySec), :max)
       ON CONFLICT (lead_id) WHERE kind = 'reply' AND status = 'pendente' ${onConflict}`,
      {
        replacements: { tenantId, leadId, key: `reply:${leadId}`, delaySec: Math.max(0, delayMs) / 1000, max: env.JOB_MAX_ATTEMPTS },
        transaction: t,
      }
    )
  );
  if (delayMs <= 0) events.emit('enqueued');
}

/** Reivindica até `limit` jobs prontos, de qualquer conta. Devolve só { id, tenantId, kind }. */
async function claim(limit) {
  const rows = await sequelize.query('SELECT id, tenant_id AS "tenantId", kind FROM aim_claim_jobs(:limit, :stale)', {
    replacements: { limit, stale: env.JOB_STALE_SEC },
    type: QueryTypes.SELECT,
  });
  return rows;
}

/** Conteúdo do job, lido no contexto da conta. */
async function load(job) {
  const [row] = await inTx(job.tenantId, (t) =>
    sequelize.query(
      `SELECT lead_id AS "leadId", payload, attempts, max_attempts AS "maxAttempts"
         FROM aim_job WHERE id = :id AND status = 'executando'`,
      { replacements: { id: job.id }, type: QueryTypes.SELECT, transaction: t }
    )
  );
  return row || null;
}

/** Concluído: apaga o payload (texto do lead) na hora; a linha some na limpeza. */
function complete(job) {
  return inTx(job.tenantId, (t) =>
    sequelize.query(
      `UPDATE aim_job SET status = 'feito', payload = '{}'::jsonb, locked_at = NULL, last_error = NULL, updated_at = now()
        WHERE id = :id`,
      { replacements: { id: job.id }, transaction: t }
    )
  );
}

/**
 * Falhou: volta para a fila com espera crescente, ou vira 'falhou' ao esgotar as tentativas.
 * Resposta com outra já pendente para o mesmo lead é descartada (a pendente cobre as mesmas mensagens).
 * @returns {'retry'|'failed'|'superseded'}
 */
async function fail(job, err) {
  return inTx(job.tenantId, async (t) => {
    const [row] = await sequelize.query(
      `SELECT kind, lead_id AS "leadId", attempts, max_attempts AS "maxAttempts" FROM aim_job WHERE id = :id FOR UPDATE`,
      { replacements: { id: job.id }, type: QueryTypes.SELECT, transaction: t }
    );
    if (!row) return 'failed';
    const label = errorLabel(err);

    if (row.attempts >= row.maxAttempts) {
      await sequelize.query(
        `UPDATE aim_job SET status = 'falhou', locked_at = NULL, last_error = :label, updated_at = now() WHERE id = :id`,
        { replacements: { id: job.id, label }, transaction: t }
      );
      // Resposta que não saiu de jeito nenhum vira aviso no painel do dono.
      if (row.kind === 'reply') {
        await quality.raiseEventInTx(t, { tenantId: job.tenantId, leadId: row.leadId, errorCode: err && err.code, attempts: row.attempts });
      }
      return 'failed';
    }

    if (row.kind === 'reply') {
      const [other] = await sequelize.query(
        `SELECT 1 AS x FROM aim_job WHERE lead_id = :leadId AND kind = 'reply' AND status = 'pendente' AND id <> :id`,
        { replacements: { id: job.id, leadId: row.leadId }, type: QueryTypes.SELECT, transaction: t }
      );
      if (other) {
        await sequelize.query(
          `UPDATE aim_job SET status = 'feito', locked_at = NULL, last_error = :label, updated_at = now() WHERE id = :id`,
          { replacements: { id: job.id, label: `${label} [substituído]`.slice(0, 200) }, transaction: t }
        );
        return 'superseded';
      }
    }

    await sequelize.query(
      `UPDATE aim_job
          SET status = 'pendente', locked_at = NULL, last_error = :label,
              run_at = now() + make_interval(secs => :delaySec), updated_at = now()
        WHERE id = :id`,
      { replacements: { id: job.id, label, delaySec: retryDelayMs(row.attempts) / 1000 }, transaction: t }
    );
    return 'retry';
  });
}

/** Limpeza: concluídos após 24 h, falhos após 7 dias. */
async function purge() {
  const [row] = await sequelize.query('SELECT aim_purge_jobs(24, 168) AS n', { type: QueryTypes.SELECT });
  return row ? row.n : 0;
}

module.exports = { enqueueInbound, enqueueReply, claim, load, complete, fail, purge, retryDelayMs, errorLabel, events };
