'use strict';

/**
 * Migration 0003 — fila de jobs no banco (substitui o debounce em memória).
 *
 *   aim_job: cada mensagem recebida vira um job `inbound` ANTES do 200 do webhook, e cada resposta
 *   da IA vira um job `reply` com run_at no futuro (o debounce). Um worker reivindica os jobs com
 *   FOR UPDATE SKIP LOCKED, então várias instâncias podem rodar ao mesmo tempo.
 *
 *   serial_key: jobs com a mesma chave (na mesma conta) rodam um de cada vez, em ordem.
 *     inbound -> 'in:<wa_id>'   (mensagens do mesmo contato na ordem de chegada)
 *     reply   -> 'reply:<lead>' (nunca duas respostas da IA ao mesmo lead em paralelo)
 *
 *   O worker atende todas as contas, mas o role da aplicação só enxerga a conta setada em
 *   app.tenant_id (RLS FORCE). Por isso a reivindicação e a limpeza passam por funções
 *   SECURITY DEFINER, donas do role de migração, com uma policy que vale só para esse role.
 *   As funções devolvem apenas id, tenant_id e kind: o conteúdo do job é lido depois, dentro de inTx().
 *
 * Idempotente e reversível.
 */

const APP_ROLE = process.env.DB_APP_ROLE || 'aim_app';
if (!/^[a-z_][a-z0-9_]*$/.test(APP_ROLE)) throw new Error('DB_APP_ROLE inválido');

async function up({ context: sequelize }) {
  await sequelize.transaction(async (t) => {
    const q = (sql) => sequelize.query(sql, { transaction: t });

    await q(`
      CREATE TABLE IF NOT EXISTS aim_job (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL REFERENCES aim_tenant(id) ON DELETE CASCADE,
        kind          text NOT NULL CHECK (kind IN ('inbound', 'reply')),
        lead_id       uuid REFERENCES aim_lead(id) ON DELETE CASCADE,
        serial_key    text,
        payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
        status        text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'executando', 'feito', 'falhou')),
        run_at        timestamptz NOT NULL DEFAULT now(),
        attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        max_attempts  integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
        last_error    text,
        locked_at     timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT aim_job_reply_lead_ck CHECK (kind <> 'reply' OR lead_id IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS aim_job_pendente_idx ON aim_job (run_at) WHERE status = 'pendente';
      CREATE INDEX IF NOT EXISTS aim_job_executando_idx ON aim_job (tenant_id, serial_key) WHERE status = 'executando';
      CREATE INDEX IF NOT EXISTS aim_job_limpeza_idx ON aim_job (updated_at) WHERE status IN ('feito', 'falhou');
      -- Uma única resposta pendente por lead: mensagem nova só empurra o run_at (debounce).
      CREATE UNIQUE INDEX IF NOT EXISTS aim_job_reply_pendente_uq ON aim_job (lead_id)
        WHERE kind = 'reply' AND status = 'pendente';

      ALTER TABLE aim_job ENABLE ROW LEVEL SECURITY;
      ALTER TABLE aim_job FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS aim_job_tenant_isolation ON aim_job;
      CREATE POLICY aim_job_tenant_isolation ON aim_job
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
      -- Só o role dono das funções abaixo (o de migração) enxerga todas as contas.
      DROP POLICY IF EXISTS aim_job_worker ON aim_job;
      CREATE POLICY aim_job_worker ON aim_job TO CURRENT_USER USING (true) WITH CHECK (true);

      GRANT SELECT, INSERT, UPDATE, DELETE ON aim_job TO ${APP_ROLE};
    `);

    // Reivindica até p_limit jobs prontos. Jobs "executando" há mais de p_stale_sec (processo caiu)
    // voltam a ser elegíveis enquanto houver tentativas.
    // Ordem estrita por serial_key: o candidato é sempre o job em aberto MAIS ANTIGO da chave (por
    // created_at), e ele só roda quando o run_at chegar. Uma mensagem que falhou e espera nova
    // tentativa segura as seguintes do mesmo contato, em vez de ser ultrapassada por elas.
    // Nenhum job roda se outro da mesma chave estiver executando.
    // p_stale_sec tem piso de 30 s: valor baixo retomaria jobs que ainda estão rodando.
    await q(`
      CREATE OR REPLACE FUNCTION aim_claim_jobs(p_limit integer, p_stale_sec integer)
      RETURNS TABLE (id uuid, tenant_id uuid, kind text)
      LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
      AS $fn$
        WITH params AS (
          SELECT now() - make_interval(secs => GREATEST(p_stale_sec, 30)) AS stale_before
        ), abertos AS (
          SELECT j.id, j.tenant_id, j.serial_key, j.status, j.run_at, j.locked_at, j.attempts, j.max_attempts, j.created_at
            FROM aim_job j
           WHERE j.status = 'pendente'
              OR (j.status = 'executando' AND j.locked_at < (SELECT stale_before FROM params) AND j.attempts < j.max_attempts)
        ), cabecas AS (
          SELECT DISTINCT ON (o.tenant_id, COALESCE(o.serial_key, o.id::text)) o.*
            FROM abertos o
           ORDER BY o.tenant_id, COALESCE(o.serial_key, o.id::text), o.created_at, o.id
        ), elegiveis AS (
          SELECT c.id FROM cabecas c
           WHERE (c.status = 'executando' OR c.run_at <= now())
             AND (c.serial_key IS NULL OR NOT EXISTS (
                   SELECT 1 FROM aim_job x
                    WHERE x.tenant_id = c.tenant_id
                      AND x.serial_key = c.serial_key
                      AND x.id <> c.id
                      AND x.status = 'executando'
                      AND x.locked_at >= (SELECT stale_before FROM params)))
        ), travados AS (
          SELECT a.id FROM aim_job a
           WHERE a.id IN (SELECT e.id FROM elegiveis e)
           ORDER BY a.run_at
           LIMIT GREATEST(1, LEAST(p_limit, 100))
           FOR UPDATE SKIP LOCKED
        )
        UPDATE aim_job u
           SET status = 'executando', locked_at = now(), attempts = u.attempts + 1, updated_at = now()
          FROM travados
         WHERE u.id = travados.id
        RETURNING u.id, u.tenant_id, u.kind;
      $fn$;

      -- Limpeza. Job travado que já esgotou as tentativas (derrubou o processo todas as vezes) vira
      -- 'falhou'. Depois apaga os concluídos (o payload de inbound tem texto do lead: não guardar além do necessário).
      CREATE OR REPLACE FUNCTION aim_purge_jobs(p_done_hours integer, p_failed_hours integer)
      RETURNS integer
      LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
      AS $fn$
        UPDATE aim_job
           SET status = 'falhou', locked_at = NULL, last_error = 'TRAVADO_SEM_TENTATIVAS', updated_at = now()
         WHERE status = 'executando'
           AND attempts >= max_attempts
           AND locked_at < now() - interval '30 minutes';
        WITH apagados AS (
          DELETE FROM aim_job
           WHERE (status = 'feito'  AND updated_at < now() - make_interval(hours => p_done_hours))
              OR (status = 'falhou' AND updated_at < now() - make_interval(hours => p_failed_hours))
          RETURNING 1
        )
        SELECT count(*)::integer FROM apagados;
      $fn$;

      REVOKE ALL ON FUNCTION aim_claim_jobs(integer, integer) FROM PUBLIC;
      REVOKE ALL ON FUNCTION aim_purge_jobs(integer, integer) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION aim_claim_jobs(integer, integer) TO ${APP_ROLE};
      GRANT EXECUTE ON FUNCTION aim_purge_jobs(integer, integer) TO ${APP_ROLE};
    `);
  });
}

async function down({ context: sequelize }) {
  await sequelize.transaction(async (t) => {
    await sequelize.query(
      `DROP FUNCTION IF EXISTS aim_claim_jobs(integer, integer);
       DROP FUNCTION IF EXISTS aim_purge_jobs(integer, integer);
       DROP TABLE IF EXISTS aim_job;`,
      { transaction: t }
    );
  });
}

module.exports = { up, down };
