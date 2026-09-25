'use strict';

/**
 * Administração de contas pela linha de comando (modo piloto: sem cadastro público, sem e-mail, sem cobrança).
 * Roda com o role de migração (DATABASE_MIGRATION_URL). Segredos (senha, token) vêm de variáveis de ambiente,
 * nunca de argumentos: não ficam no histórico do terminal nem na lista de processos, e nunca são impressos.
 *
 *   CONTA_SENHA=<senha> npm run conta -- criar --slug imob-x --nome "Imobiliária X" --admin-nome "Ana" --admin-email ana@x.com.br [--assistente "Sofia"] [--fuso America/Sao_Paulo]
 *   npm run conta -- listar
 *   CONTA_SENHA=<senha> npm run conta -- senha --slug imob-x --email ana@x.com.br
 *   [WA_TOKEN_NEW=<token>] npm run conta -- whatsapp --slug imob-x --phone-id 123 --numero 5511999999999 [--dono 5511988888888] [--waba 456]
 *   npm run conta -- whatsapp --slug imob-x --desconectar
 *   npm run conta -- plano --slug imob-x --plano interno
 */

require('dotenv').config();
const bcrypt = require('bcrypt');
const { Sequelize, QueryTypes } = require('sequelize');
const { encrypt } = require('../services/crypto');
const { PLANS, TRIAL_DAYS } = require('../config/plans');
const { isValidTimezone } = require('../services/time');

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;
const DIGITS = (min, max) => new RegExp(`^[0-9]{${min},${max}}$`);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new Error(`Argumento inesperado: ${a}`);
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else {
      opts[key] = next;
      i += 1;
    }
  }
  return { command, opts };
}

function need(opts, key, re, msg) {
  const v = opts[key];
  if (typeof v !== 'string' || (re && !re.test(v))) throw new Error(msg || `Informe --${key}`);
  return v;
}

function secret(name, min, msg) {
  const v = (process.env[name] || '').trim();
  if (v.length < min) throw new Error(msg);
  return v;
}

/** Transação no contexto da conta (as tabelas com tenant_id têm RLS FORCE). */
function inTenant(db, tenantId, fn) {
  return db.transaction(async (t) => {
    await db.query("SELECT set_config('app.tenant_id', :id, true)", { replacements: { id: tenantId }, transaction: t });
    return fn(t);
  });
}

async function tenantBySlug(db, slug) {
  const [row] = await db.query('SELECT id, slug, name FROM aim_tenant WHERE slug = :slug', { replacements: { slug }, type: QueryTypes.SELECT });
  if (!row) throw new Error(`Conta "${slug}" não encontrada`);
  return row;
}

async function criar(db, opts, env = process.env) {
  const slug = need(opts, 'slug', SLUG_RE, 'Informe --slug com 3 a 40 letras minúsculas, números ou hífen');
  const nome = need(opts, 'nome', /^.{2,80}$/, 'Informe --nome (2 a 80 caracteres)');
  const adminNome = need(opts, 'admin-nome', /^.{2,80}$/, 'Informe --admin-nome');
  const email = need(opts, 'admin-email', /^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'Informe --admin-email válido').toLowerCase();
  const assistente = typeof opts.assistente === 'string' ? opts.assistente.slice(0, 40) : 'Assistente';
  const fuso = typeof opts.fuso === 'string' ? opts.fuso : 'America/Sao_Paulo';
  if (!isValidTimezone(fuso)) throw new Error(`Fuso inválido: ${fuso}`);
  const senha = (env.CONTA_SENHA || '').trim();
  if (senha.length < 10) throw new Error('Defina CONTA_SENHA com pelo menos 10 caracteres');
  const hash = await bcrypt.hash(senha, 12);

  const [exists] = await db.query('SELECT 1 FROM aim_tenant WHERE slug = :slug', { replacements: { slug }, type: QueryTypes.SELECT });
  if (exists) throw new Error(`Já existe a conta "${slug}"`);

  return db.transaction(async (t) => {
    const [tenant] = await db.query(
      `INSERT INTO aim_tenant (slug, name, assistant_name, timezone) VALUES (:slug, :nome, :assistente, :fuso) RETURNING id`,
      { replacements: { slug, nome, assistente, fuso }, type: QueryTypes.SELECT, transaction: t }
    );
    await db.query("SELECT set_config('app.tenant_id', :id, true)", { replacements: { id: tenant.id }, transaction: t });
    await db.query(
      `INSERT INTO aim_user (tenant_id, name, email, password_hash, role, email_verified_at) VALUES (:id, :nome, :email, :hash, 'admin', now())`,
      { replacements: { id: tenant.id, nome: adminNome, email, hash }, transaction: t }
    );
    // Conta de piloto: plano interno, sem limite e sem vencimento (continua assim quando a cobrança for ligada).
    await db.query(`INSERT INTO aim_subscription (tenant_id, plan, status) VALUES (:id, 'interno', 'ativa')`, { replacements: { id: tenant.id }, transaction: t });
    return { id: tenant.id, slug, email };
  });
}

async function listar(db) {
  const tenants = await db.query(
    `SELECT t.id, t.slug, t.name, t.is_active AS ativo, t.wa_phone_number_id IS NOT NULL AS whatsapp, t.wa_access_token_enc IS NOT NULL AS "tokenProprio",
            COALESCE(s.plan, 'interno') AS plano, COALESCE(s.status, 'ativa') AS situacao
       FROM aim_tenant t LEFT JOIN aim_subscription s ON s.tenant_id = t.id
      ORDER BY t.created_at`,
    { type: QueryTypes.SELECT }
  );
  for (const tn of tenants) {
    // Filtro explícito por conta: o role de migração pode ignorar o RLS (superusuário no Docker).
    const [c] = await inTenant(db, tn.id, (t) =>
      db.query(
        `SELECT (SELECT count(*) FROM aim_user WHERE tenant_id = :id)::int AS usuarios,
                (SELECT count(*) FROM aim_lead WHERE tenant_id = :id)::int AS leads,
                (SELECT count(*) FROM aim_property WHERE tenant_id = :id AND is_active)::int AS imoveis`,
        { replacements: { id: tn.id }, type: QueryTypes.SELECT, transaction: t }
      )
    );
    Object.assign(tn, c);
    delete tn.id;
  }
  return tenants;
}

async function senha(db, opts, env = process.env) {
  const slug = need(opts, 'slug', SLUG_RE);
  const email = need(opts, 'email', /@/).toLowerCase();
  const nova = (env.CONTA_SENHA || '').trim();
  if (nova.length < 10) throw new Error('Defina CONTA_SENHA com pelo menos 10 caracteres');
  const tenant = await tenantBySlug(db, slug);
  const hash = await bcrypt.hash(nova, 12);
  return inTenant(db, tenant.id, async (t) => {
    const [u] = await db.query(
      `UPDATE aim_user SET password_hash = :hash, email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
        WHERE lower(email) = :email RETURNING id`,
      { replacements: { hash, email }, type: QueryTypes.SELECT, transaction: t }
    );
    if (!u) throw new Error(`Usuário ${email} não encontrado na conta "${slug}"`);
    // Troca de senha encerra as sessões abertas.
    await db.query('UPDATE aim_refresh_token SET revoked_at = now(), updated_at = now() WHERE user_id = :id AND revoked_at IS NULL', { replacements: { id: u.id }, transaction: t });
    return { slug, email };
  });
}

async function whatsapp(db, opts, env = process.env) {
  const slug = need(opts, 'slug', SLUG_RE);
  const tenant = await tenantBySlug(db, slug);
  if (opts.desconectar) {
    await db.query(
      `UPDATE aim_tenant SET wa_phone_number_id = NULL, wa_display_phone = NULL, wa_waba_id = NULL, wa_access_token_enc = NULL, wa_token_updated_at = now(), updated_at = now() WHERE id = :id`,
      { replacements: { id: tenant.id } }
    );
    return { slug, conectado: false };
  }
  const phoneId = need(opts, 'phone-id', DIGITS(5, 30), 'Informe --phone-id (Phone number ID da Meta, só dígitos)');
  const numero = need(opts, 'numero', DIGITS(10, 15), 'Informe --numero com DDI e DDD, só dígitos (ex.: 5511999999999)');
  const dono = opts.dono === undefined ? undefined : need(opts, 'dono', DIGITS(10, 15), '--dono deve ter DDI e DDD, só dígitos');
  const waba = opts.waba === undefined ? undefined : need(opts, 'waba', DIGITS(5, 30), '--waba deve ter só dígitos');
  const token = (env.WA_TOKEN_NEW || '').trim();
  if (token && token.length < 20) throw new Error('WA_TOKEN_NEW parece incompleto');
  const [other] = await db.query('SELECT slug FROM aim_tenant WHERE wa_phone_number_id = :p AND id <> :id', { replacements: { p: phoneId, id: tenant.id }, type: QueryTypes.SELECT });
  if (other) throw new Error(`Este Phone number ID já está na conta "${other.slug}"`);
  await db.query(
    `UPDATE aim_tenant
        SET wa_phone_number_id = :phoneId, wa_display_phone = :numero,
            owner_whatsapp = COALESCE(:dono, owner_whatsapp), wa_waba_id = COALESCE(:waba, wa_waba_id),
            wa_access_token_enc = COALESCE(:enc, wa_access_token_enc),
            wa_token_updated_at = CASE WHEN :enc IS NULL THEN wa_token_updated_at ELSE now() END,
            updated_at = now()
      WHERE id = :id`,
    { replacements: { id: tenant.id, phoneId, numero, dono: dono || null, waba: waba || null, enc: token ? encrypt(token, tenant.id) : null } }
  );
  return { slug, conectado: true, tokenProprio: Boolean(token) };
}

async function plano(db, opts) {
  const slug = need(opts, 'slug', SLUG_RE);
  const nome = need(opts, 'plano', /^[a-z_]{3,30}$/, `Informe --plano (${Object.keys(PLANS).join(', ')})`);
  if (!PLANS[nome]) throw new Error(`Plano desconhecido: ${nome}. Use ${Object.keys(PLANS).join(', ')}`);
  const tenant = await tenantBySlug(db, slug);
  const status = nome === 'teste' ? 'teste' : 'ativa';
  await db.query(
    `INSERT INTO aim_subscription (tenant_id, plan, status, trial_ends_at)
     VALUES (:id, :plan, :status, CASE WHEN :status = 'teste' THEN now() + make_interval(days => :days) END)
     ON CONFLICT (tenant_id) DO UPDATE SET plan = EXCLUDED.plan, status = EXCLUDED.status, trial_ends_at = EXCLUDED.trial_ends_at,
       pending_plan = NULL, grace_until = NULL, updated_at = now()`,
    { replacements: { id: tenant.id, plan: nome, status, days: TRIAL_DAYS } }
  );
  return { slug, plano: nome, situacao: status };
}

const COMMANDS = { criar, listar, senha, whatsapp, plano };

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  const fn = COMMANDS[command];
  if (!fn) throw new Error(`Comando desconhecido. Use: ${Object.keys(COMMANDS).join(', ')}`);
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL não definida');
  const db = new Sequelize(url, { dialect: 'postgres', logging: false });
  try {
    const out = await fn(db, opts);
    if (Array.isArray(out)) console.table(out);
    else console.log(JSON.stringify(out, null, 2));
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Falha:', err.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, criar, listar, senha, whatsapp, plano };
