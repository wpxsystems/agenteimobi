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

    // Imóveis FICTÍCIOS de exemplo, um de cada tipo — editar pela API/painel com os dados reais.
    const exemplos = [
      {
        code: 'CASA01', title: 'Casa 2 quartos com quintal (exemplo)', deal: 'aluguel',
        description: 'Casa térrea, 2 quartos, sala, cozinha, quintal e 1 vaga.',
        location: 'Bairro Exemplo - Cidade Exemplo', price: 200000, fees: 15000, bedrooms: 2, pets: true, max: 4,
        guarantees: ['caucao', 'seguro_fianca'], extra: 'Dados de exemplo: substituir pelos reais.',
      },
      {
        code: 'APTO01', title: 'Apartamento 1 quarto perto do metrô (exemplo)', deal: 'aluguel',
        description: 'Apartamento de 45 m², 1 quarto, sala, cozinha americana e 1 vaga. Prédio com portaria 24h e elevador.',
        location: 'Centro - Cidade Exemplo', price: 180000, fees: 45000, bedrooms: 1, pets: false, max: 2,
        guarantees: ['fiador', 'seguro_fianca'],
        extra: 'Não aceita animais. Condomínio inclui água e gás. Visitas de segunda a sexta, das 9h às 18h. Vaga coberta, sem vaga para visitantes.',
      },
      {
        code: 'KIT01', title: 'Kitnet mobiliada para uma pessoa (exemplo)', deal: 'aluguel',
        description: 'Kitnet de 25 m² mobiliada: cama, armário, geladeira, micro-ondas e cooktop. Sem vaga de garagem.',
        location: 'Bairro Universitário - Cidade Exemplo', price: 95000, fees: 12000, bedrooms: 0, pets: null, max: 1,
        guarantees: ['caucao', 'seguro_fianca', 'titulo_capitalizacao'],
        extra: 'Ideal para estudante. Contrato mínimo de 6 meses. Internet inclusa no condomínio. Lavanderia coletiva no térreo.',
      },
      {
        code: 'CASA02', title: 'Sobrado 3 quartos à venda com garagem (exemplo)', deal: 'venda',
        description: 'Sobrado de 140 m², 3 quartos (1 suíte), 2 banheiros, churrasqueira e 2 vagas cobertas.',
        location: 'Jardim Exemplo - Cidade Exemplo', price: 45000000, fees: 0, bedrooms: 3, pets: true, max: null,
        guarantees: [],
        extra: 'Aceita financiamento bancário e uso de FGTS. Documentação regularizada. IPTU anual de R$ 1.800. Visitas com agendamento, inclusive sábado.',
      },
      {
        code: 'SALA01', title: 'Sala comercial 40 m² em prédio com recepção (exemplo)', deal: 'aluguel',
        description: 'Sala comercial de 40 m² com banheiro privativo, ar-condicionado e 1 vaga rotativa.',
        location: 'Centro Empresarial - Cidade Exemplo', price: 150000, fees: 60000, bedrooms: null, pets: false, max: null,
        guarantees: ['caucao', 'seguro_fianca', 'fiador'],
        extra: 'Uso comercial apenas. Prédio com recepção, elevador e gerador; funciona de segunda a sábado até as 20h. Condomínio inclui limpeza das áreas comuns.',
      },
    ];
    for (const p of exemplos) {
      await q(
        `INSERT INTO aim_property (tenant_id, code, title, description, location_summary, deal_type, price_cents, fees_cents,
                                   bedrooms, allows_pets, max_occupants, accepted_guarantees, extra_info)
         VALUES (:tid, :code, :title, :description, :location, :deal, :price, :fees, :bedrooms, :pets, :max,
                 :guarantees::text[], :extra)
         ON CONFLICT (tenant_id, code) DO NOTHING
         RETURNING id`,
        { tid: tenant.id, ...p, guarantees: `{${p.guarantees.join(',')}}` } // literal de array do Postgres ('{}' = vazio)
      );
    }
    console.log(`Seed ok: tenant "${slug}" (${tenant.id})`);
  });
  await sequelize.close();
}

main().catch((err) => {
  console.error('Falha no seed:', err.message);
  process.exit(1);
});
