'use strict';

const path = require('path');
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
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      // Em dev o painel roda em http://localhost; o upgrade para https quebraria as chamadas.
      directives: {
        'upgrade-insecure-requests': env.isDev ? null : [],
        // Cadastro incorporado da Meta (conectar o WhatsApp): só libera o SDK do Facebook quando está configurado.
        ...(env.embeddedSignup
          ? {
              'script-src': ["'self'", 'https://connect.facebook.net'],
              'frame-src': ["'self'", 'https://www.facebook.com', 'https://web.facebook.com'],
              'connect-src': ["'self'", 'https://graph.facebook.com', 'https://www.facebook.com'],
            }
          : {}),
      },
    },
  })
);
app.use(
  pinoHttp({
    logger,
    // Não loga query string (pode ter verify_token/src) nem corpo.
    serializers: { req: (req) => ({ method: req.method, url: req.url.split('?')[0] }) },
    autoLogging: { ignore: (req) => req.url === '/health' },
  })
);

app.get('/health', (_req, res) => res.json({ success: true, data: { status: 'ok' } }));

// Painel web (estático, mesma origem da API) e página de privacidade.
const publicDir = path.join(__dirname, '..', 'public');
app.get('/', (_req, res) => res.redirect('/painel/'));
app.use('/painel', express.static(path.join(publicDir, 'painel'), { index: 'index.html' }));
// Páginas legais (rascunhos em revisão; versões em src/config/legal.js).
app.get('/privacidade', (_req, res) => res.sendFile(path.join(publicDir, 'privacidade.html')));
app.get('/privacidade/atendimento', (_req, res) => res.sendFile(path.join(publicDir, 'privacidade-atendimento.html')));
app.get('/termos', (_req, res) => res.sendFile(path.join(publicDir, 'termos.html')));
app.get('/legal.css', (_req, res) => res.sendFile(path.join(publicDir, 'legal.css')));

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
