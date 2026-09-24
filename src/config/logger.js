'use strict';

const pino = require('pino');
const env = require('./env');

// Nunca logar segredo nem PII (telefone, nome, texto de mensagem).
const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-hub-signature-256"]',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.refreshToken',
      '*.accessToken',
      '*.phone',
      '*.waId',
      '*.text',
      '*.body',
      '*.name',
    ],
    censor: '[REDACTED]',
  },
});

module.exports = logger;
