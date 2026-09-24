'use strict';

require('dotenv').config();
const path = require('path');
const { Sequelize } = require('sequelize');
const { Umzug, SequelizeStorage } = require('umzug');

// Migrations rodam com o usuário OWNER, nunca com o usuário da aplicação.
const url = process.env.DATABASE_MIGRATION_URL;
if (!url) throw new Error('DATABASE_MIGRATION_URL não definida');

const sequelize = new Sequelize(url, { dialect: 'postgres', logging: false });

const umzug = new Umzug({
  migrations: { glob: path.join(__dirname, 'migrations', '*.js').replace(/\\/g, '/') },
  context: sequelize,
  storage: new SequelizeStorage({ sequelize, tableName: 'aim_schema_migration' }),
  logger: console,
});

async function main() {
  const cmd = process.argv[2] || 'up';
  if (cmd === 'up') await umzug.up();
  else if (cmd === 'down') await umzug.down();
  else throw new Error(`Comando desconhecido: ${cmd}`);
  await sequelize.close();
}

main().catch(async (err) => {
  console.error('Falha na migration:', err.message);
  await sequelize.close();
  process.exit(1);
});
