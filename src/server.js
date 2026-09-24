'use strict';

const env = require('./config/env');
const logger = require('./config/logger');
const app = require('./app');
const { sequelize } = require('./models');
const followUpJob = require('./jobs/followUp.job');

async function main() {
  await sequelize.authenticate();
  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'AgenteImobi no ar'));
  const stopJob = followUpJob.start();

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Encerrando');
    stopJob();
    server.close(async () => {
      await sequelize.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.fatal({ message: err.message }, 'Falha ao iniciar');
  process.exit(1);
});
