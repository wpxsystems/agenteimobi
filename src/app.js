'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const env = require('./config/env');
const logger = require('./config/logger');
const { api, webhooks, publicLinks } = require('./routes');
const { notFound, errorHandler } = require('./middlewares');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // atrás do Traefik
app.use(helmet());
app.use(
  pinoHttp({
    logger,
    // Não loga query string (pode ter verify_token/src) nem corpo.
    serializers: { req: (req) => ({ method: req.method, url: req.url.split('?')[0] }) },
    autoLogging: { ignore: (req) => req.url === '/health' },
  })
);

app.get('/health', (_req, res) => res.json({ success: true, data: { status: 'ok' } }));

// Webhook ANTES do express.json: precisa do corpo bruto.
app.use('/webhooks', webhooks);
app.use('/r', publicLinks);

app.use(
  '/api/v1',
  cors({ origin: env.corsOrigins.length ? env.corsOrigins : false, credentials: false }),
  express.json({ limit: '100kb' }),
  api
);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
