'use strict';

const env = require('./config/env');
const logger = require('./config/logger');
const app = require('./app');
const { sequelize } = require('./models');
const followUpJob = require('./jobs/followUp.job');
const { createWorker } = require('./jobs/worker');
const retentionJob = require('./jobs/retention.job');
const routinesJob = require('./jobs/routines.job');

async function main() {
  await sequelize.authenticate();
  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'AgenteImobi no ar'));
  const stopJob = followUpJob.start();
  const stopRetention = retentionJob.start();
  const stopRoutines = routinesJob.start();
  const worker = createWorker();
  worker.start();

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Encerrando');
    stopJob();
    stopRetention();
    stopRoutines();
    server.close(async () => {
      // Termina os jobs em andamento; o que não terminar volta para a fila (JOB_STALE_SEC).
      await worker.stop();
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
