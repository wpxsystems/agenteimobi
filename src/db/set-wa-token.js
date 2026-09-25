'use strict';

/**
 * Grava (ou apaga) o token do WhatsApp de uma conta, cifrado com WA_TOKEN_ENC_KEY.
 * Ferramenta de operação até existir a conexão pelo painel (item 1.2 do plano).
 * Roda com o role de migração, porque o role da aplicação só lê aim_tenant.
 *
 *   WA_TOKEN_NEW=<token> npm run tenant:wa-token -- <slug> [--waba <waba_id>]
 *   npm run tenant:wa-token -- <slug> --clear
 *
 * O token vem de variável de ambiente, não de argumento, para não ficar no histórico do shell
 * nem na lista de processos. Nunca é impresso.
 */

require('dotenv').config();
const { Sequelize, QueryTypes } = require('sequelize');
const { encrypt, decrypt } = require('../services/crypto');

function parseArgs(argv) {
  const [slug, ...rest] = argv;
  const opts = { slug, clear: false, waba: null };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--clear') opts.clear = true;
    else if (rest[i] === '--waba') opts.waba = rest[++i];
    else throw new Error(`Argumento desconhecido: ${rest[i]}`);
  }
  if (!opts.slug || !/^[a-z0-9-]{3,40}$/.test(opts.slug)) throw new Error('Informe o slug da conta');
  if (opts.waba !== null && !/^[0-9]{5,30}$/.test(opts.waba || '')) throw new Error('--waba deve ter só dígitos');
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL não definida');
  const sequelize = new Sequelize(url, { dialect: 'postgres', logging: false });
  try {
    const [tenant] = await sequelize.query('SELECT id FROM aim_tenant WHERE slug = :slug', {
      replacements: { slug: opts.slug },
      type: QueryTypes.SELECT,
    });
    if (!tenant) throw new Error(`Conta "${opts.slug}" não encontrada`);

    if (opts.clear) {
      await sequelize.query(
        'UPDATE aim_tenant SET wa_access_token_enc = NULL, wa_token_updated_at = now(), updated_at = now() WHERE id = :id',
        { replacements: { id: tenant.id } }
      );
      console.log(`Token removido da conta "${opts.slug}".`);
      return;
    }

    const token = (process.env.WA_TOKEN_NEW || '').trim();
    if (token.length < 20) throw new Error('Defina WA_TOKEN_NEW com o token da Meta');
    const enc = encrypt(token, tenant.id);
    if (decrypt(enc, tenant.id) !== token) throw new Error('Verificação da cifra falhou');

    await sequelize.query(
      `UPDATE aim_tenant
          SET wa_access_token_enc = :enc, wa_token_updated_at = now(), updated_at = now(),
              wa_waba_id = COALESCE(:waba, wa_waba_id)
        WHERE id = :id`,
      { replacements: { id: tenant.id, enc, waba: opts.waba } }
    );
    console.log(`Token gravado (cifrado) na conta "${opts.slug}".`);
  } finally {
    await sequelize.close();
  }
}

main().catch((err) => {
  console.error('Falha:', err.message);
  process.exit(1);
});
