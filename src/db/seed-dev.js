'use strict';

/**
 * Seed de DESENVOLVIMENTO/TESTE — idempotente. Cria a conta (tenant), um admin e um imóvel de exemplo.
 * Nada de credencial fixa: tudo vem de variáveis SEED_* (ver .env.example).
 * Roda com o usuário OWNER; como as tabelas têm RLS FORCE, seta o tenant na transação.
 */

require('dotenv').config();
const bcrypt = require('bcrypt');
const { Sequelize, QueryTypes } = require('sequelize');

const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Defina ${k} no .env para rodar o seed`);
  return v;
};

async function main() {
  const sequelize = new Sequelize(need('DATABASE_MIGRATION_URL'), { dialect: 'postgres', logging: false });
  const slug = need('SEED_TENANT_SLUG');
  const password = need('SEED_ADMIN_PASSWORD');
  if (password.length < 12) throw new Error('SEED_ADMIN_PASSWORD precisa de ao menos 12 caracteres');
  const hash = await bcrypt.hash(password, 12);

  await sequelize.transaction(async (t) => {
    const q = (sql, replacements) => sequelize.query(sql, { replacements, transaction: t, type: QueryTypes.SELECT });

    const [tenant] = await q(
      `INSERT INTO aim_tenant (slug, name, assistant_name, wa_phone_number_id, wa_display_phone, owner_whatsapp)
       VALUES (:slug, :name, :assistant, :phoneId, :display, :owner)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name, assistant_name = EXCLUDED.assistant_name,
         wa_phone_number_id = EXCLUDED.wa_phone_number_id, wa_display_phone = EXCLUDED.wa_display_phone,
         owner_whatsapp = EXCLUDED.owner_whatsapp, updated_at = now()
       RETURNING id`,
      {
        slug,
        name: need('SEED_TENANT_NAME'),
        assistant: process.env.SEED_ASSISTANT_NAME || 'Assistente',
        phoneId: process.env.SEED_WA_PHONE_NUMBER_ID || null,
        display: process.env.SEED_WA_DISPLAY_PHONE || null,
        owner: process.env.SEED_OWNER_WHATSAPP || null,
      }
    );

    await q("SELECT set_config('app.tenant_id', :tid, true)", { tid: tenant.id });

    await q(
      `INSERT INTO aim_user (tenant_id, name, email, password_hash, role)
       SELECT :tid, 'Administrador', :email, :hash, 'admin'
       WHERE NOT EXISTS (SELECT 1 FROM aim_user WHERE tenant_id = :tid AND lower(email) = lower(:email))
       RETURNING id`,
      { tid: tenant.id, email: need('SEED_ADMIN_EMAIL'), hash }
    );

    // Imóvel FICTÍCIO de exemplo — editar pela API com os dados reais da casa.
    await q(
      `INSERT INTO aim_property (tenant_id, code, title, description, location_summary, price_cents, fees_cents,
                                 bedrooms, allows_pets, max_occupants, accepted_guarantees, extra_info)
       VALUES (:tid, 'CASA01', 'Casa 2 quartos com quintal (exemplo)', 'Casa térrea, 2 quartos, sala, cozinha, quintal e 1 vaga.',
               'Bairro Exemplo - Cidade Exemplo', 200000, 15000, 2, true, 4,
               ARRAY['caucao','seguro_fianca']::text[], 'Dados de exemplo: substituir pelos reais.')
       ON CONFLICT (tenant_id, code) DO NOTHING
       RETURNING id`,
      { tid: tenant.id }
    );
    console.log(`Seed ok: tenant "${slug}" (${tenant.id})`);
  });
  await sequelize.close();
}

main().catch((err) => {
  console.error('Falha no seed:', err.message);
  process.exit(1);
});
