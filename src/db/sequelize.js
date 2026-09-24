'use strict';

const { Sequelize } = require('sequelize');
const env = require('../config/env');

// Conexão da APLICAÇÃO: usuário sem SUPERUSER/BYPASSRLS, sujeito às policies de RLS.
const sequelize = new Sequelize(env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  define: {
    underscored: true,
    freezeTableName: true,
    timestamps: true,
  },
  pool: { max: 10, min: 0, idle: 10000 },
});

module.exports = sequelize;
