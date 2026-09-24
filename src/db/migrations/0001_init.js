'use strict';

/**
 * Migration inicial — idempotente e reversível.
 * Roda com o usuário OWNER (DATABASE_MIGRATION_URL). A aplicação usa o role `aim_app`,
 * sem SUPERUSER/BYPASSRLS, e toda tabela com tenant_id tem RLS FORCE.
 *
 * Prefixo de tabela: aim_ (AgenteImobi).
 */

const APP_ROLE = process.env.DB_APP_ROLE || 'aim_app';
if (!/^[a-z_][a-z0-9_]*$/.test(APP_ROLE)) throw new Error('DB_APP_ROLE inválido');

const TENANT_TABLES = [
  'aim_user',
  'aim_refresh_token',
  'aim_property',
  'aim_lead',
  'aim_message',
  'aim_link_click',
];

function rlsSql(table) {
  return `
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS ${table}_tenant_isolation ON ${table};
    CREATE POLICY ${table}_tenant_isolation ON ${table}
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  `;
}

async function up({ context: sequelize }) {
  await sequelize.transaction(async (t) => {
    const q = (sql) => sequelize.query(sql, { transaction: t });

    await q(`
      CREATE TABLE IF NOT EXISTS aim_tenant (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug                text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,40}$'),
        name                text NOT NULL,
        assistant_name      text NOT NULL DEFAULT 'Assistente',
        wa_phone_number_id  text UNIQUE,
        wa_display_phone    text CHECK (wa_display_phone ~ '^[0-9]{10,15}$'),
        owner_whatsapp      text CHECK (owner_whatsapp ~ '^[0-9]{10,15}$'),
        is_active           boolean NOT NULL DEFAULT true,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS aim_user (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL REFERENCES aim_tenant(id) ON DELETE CASCADE,
        name           text NOT NULL,
        email          text NOT NULL,
        password_hash  text NOT NULL,
        role           text NOT NULL DEFAULT 'corretor' CHECK (role IN ('admin', 'corretor')),
        is_active      boolean NOT NULL DEFAULT true,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS aim_user_tenant_email_uq ON aim_user (tenant_id, lower(email));

      CREATE TABLE IF NOT EXISTS aim_refresh_token (
        id           uuid PRIMARY KEY,
        tenant_id    uuid NOT NULL REFERENCES aim_tenant(id) ON DELETE CASCADE,
        user_id      uuid NOT NULL REFERENCES aim_user(id) ON DELETE CASCADE,
        expires_at   timestamptz NOT NULL,
        revoked_at   timestamptz,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS aim_refresh_token_user_idx ON aim_refresh_token (user_id);

      CREATE TABLE IF NOT EXISTS aim_property (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id            uuid NOT NULL REFERENCES aim_tenant(id) ON DELETE CASCADE,
        code                 text NOT NULL CHECK (code ~ '^[A-Z0-9]{3,12}$'),
        title                text NOT NULL,
        description          text NOT NULL DEFAULT '',
        location_summary     text NOT NULL DEFAULT '',
        deal_type            text NOT NULL DEFAULT 'aluguel' CHECK (deal_type IN ('aluguel', 'venda')),
        price_cents          bigint NOT NULL CHECK (price_cents > 0),
        fees_cents           bigint NOT NULL DEFAULT 0 CHECK (fees_cents >= 0),
        bedrooms             integer CHECK (bedrooms >= 0),
        allows_pets          boolean,
        max_occupants        integer CHECK (max_occupants > 0),
        accepted_guarantees  text[] NOT NULL DEFAULT '{}',
        available_from       date,
        extra_info           text NOT NULL DEFAULT '',
        is_active            boolean NOT NULL DEFAULT true,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT aim_property_tenant_code_uq UNIQUE (tenant_id, code)
      );

      CREATE TABLE IF NOT EXISTS aim_lead (
        id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id               uuid NOT NULL REFERENCES aim_tenant(id) ON DELETE CASCADE,
        property_id             uuid REFERENCES aim_property(id) ON DELETE SET NULL,
        wa_id                   text NOT NULL CHECK (wa_id ~ '^[0-9]{8,15}$'),
        display_name            text,
        status                  text NOT NULL DEFAULT 'novo'
                                CHECK (status IN ('novo', 'em_atendimento', 'transferido', 'visita_agendada', 'descartado', 'opt_out')),
        classification          text NOT NULL DEFAULT 'indefinido'
                                CHECK (classification IN ('indefinido', 'quente', 'morno', 'frio')),
        score                   integer NOT NULL DEFAULT 0,
        qualification           jsonb NOT NULL DEFAULT '{}'::jsonb,
        disqualify_reasons      text[] NOT NULL DEFAULT '{}',
        visit_preference        text,
        bot_active              boolean NOT NULL DEFAULT true,
        handoff_reason          text,
        handoff_at              timestamptz,
        last_inbound_at         timestamptz,
        last_outbound_at        timestamptz,
        last_replied_inbound_at timestamptz,
        followup_count          integer NOT NULL DEFAULT 0,
        privacy_notice_sent_at  timestamptz,
        opt_out_at              timestamptz,
        source                  text,
        created_at              timestamptz NOT NULL DEFAULT now(),
        updated_at              timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT aim_lead_tenant_wa_uq UNIQUE (tenant_id, wa_id)
      );
      CREATE INDEX IF NOT EXISTS aim_lead_tenant_class_idx ON aim_lead (tenant_id, classification, status);

      CREATE TABLE IF NOT EXISTS aim_message (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL REFERENCES aim_tenant(id) ON DELETE CASCADE,
        lead_id        uuid NOT NULL REFERENCES aim_lead(id) ON DELETE CASCADE,
        direction      text NOT NULL CHECK (direction IN ('in', 'out')),
        author         text NOT NULL CHECK (author IN ('lead', 'bot', 'human', 'system')),
        wa_message_id  text,
        msg_type       text NOT NULL DEFAULT 'text',
        body           text NOT NULL DEFAULT '',
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS aim_message_wa_uq ON aim_message (tenant_id, wa_message_id)
        WHERE wa_message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS aim_message_lead_idx ON aim_message (lead_id, created_at);

      CREATE TABLE IF NOT EXISTS aim_link_click (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    uuid NOT NULL REFERENCES aim_tenant(id) ON DELETE CASCADE,
        property_id  uuid NOT NULL REFERENCES aim_property(id) ON DELETE CASCADE,
        source       text CHECK (source ~ '^[a-z0-9_-]{1,30}$'),
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS aim_link_click_property_idx ON aim_link_click (tenant_id, property_id, created_at);
    `);

    for (const table of TENANT_TABLES) {
      await q(rlsSql(table));
    }

    // Permissões do role da aplicação: tenant só leitura (webhook/login/redirect resolvem tenant por ele).
    await q(`
      GRANT SELECT ON aim_tenant TO ${APP_ROLE};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ${TENANT_TABLES.join(', ')} TO ${APP_ROLE};
    `);
  });
}

async function down({ context: sequelize }) {
  await sequelize.transaction(async (t) => {
    await sequelize.query(
      `DROP TABLE IF EXISTS aim_link_click, aim_message, aim_lead, aim_property,
         aim_refresh_token, aim_user, aim_tenant CASCADE;`,
      { transaction: t }
    );
  });
}

module.exports = { up, down };
