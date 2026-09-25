'use strict';

// Worker da fila com job.service, conversa e models mockados: sem banco, sem rede.

jest.mock('../src/services/job.service', () => {
  const { EventEmitter: EE } = require('events');
  return {
    events: new EE(),
    claim: jest.fn(async () => []),
    load: jest.fn(async () => ({ leadId: 'lead-1', payload: { waId: '5511900000000', text: 'oi' } })),
    complete: jest.fn(async () => {}),
    fail: jest.fn(async () => 'retry'),
    purge: jest.fn(async () => 0),
  };
});
jest.mock('../src/services/conversation.service', () => ({
  handleInbound: jest.fn(async () => {}),
  processReply: jest.fn(async () => {}),
}));
jest.mock('../src/models', () => ({
  Tenant: { findByPk: jest.fn(async (id) => ({ id, isActive: true })) },
}));

const jobs = require('../src/services/job.service');
const conversation = require('../src/services/conversation.service');
const { Tenant } = require('../src/models');
const { createWorker } = require('../src/jobs/worker');

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  jobs.claim.mockResolvedValue([]);
});

test('job inbound: processa a mensagem e conclui', async () => {
  jobs.claim.mockResolvedValueOnce([{ id: 'j1', tenantId: 't1', kind: 'inbound' }]);
  const w = createWorker({ concurrency: 2, pollMs: 10000 });
  w.start();
  await flush();
  await w.idle();
  await w.stop();
  expect(conversation.handleInbound).toHaveBeenCalledWith({ waId: '5511900000000', text: 'oi' }, 't1');
  expect(jobs.complete).toHaveBeenCalledWith(expect.objectContaining({ id: 'j1' }));
  expect(jobs.fail).not.toHaveBeenCalled();
});

test('job reply: carrega a conta e responde o lead do job', async () => {
  jobs.claim.mockResolvedValueOnce([{ id: 'j2', tenantId: 't1', kind: 'reply' }]);
  const w = createWorker({ concurrency: 1, pollMs: 10000 });
  w.start();
  await flush();
  await w.idle();
  await w.stop();
  expect(Tenant.findByPk).toHaveBeenCalledWith('t1');
  expect(conversation.processReply).toHaveBeenCalledWith({ id: 't1', isActive: true }, 'lead-1');
  expect(jobs.complete).toHaveBeenCalled();
});

test('conta desativada: descarta a resposta sem erro', async () => {
  Tenant.findByPk.mockResolvedValueOnce({ id: 't1', isActive: false });
  jobs.claim.mockResolvedValueOnce([{ id: 'j3', tenantId: 't1', kind: 'reply' }]);
  const w = createWorker({ concurrency: 1, pollMs: 10000 });
  w.start();
  await flush();
  await w.idle();
  await w.stop();
  expect(conversation.processReply).not.toHaveBeenCalled();
  expect(jobs.complete).toHaveBeenCalled();
});

test('erro no job vai para fail e não conclui', async () => {
  const err = Object.assign(new Error('falha'), { code: 'WHATSAPP_SEND_FAILED' });
  conversation.handleInbound.mockRejectedValueOnce(err);
  jobs.claim.mockResolvedValueOnce([{ id: 'j4', tenantId: 't1', kind: 'inbound' }]);
  const w = createWorker({ concurrency: 1, pollMs: 10000 });
  w.start();
  await flush();
  await w.idle();
  await w.stop();
  expect(jobs.fail).toHaveBeenCalledWith(expect.objectContaining({ id: 'j4' }), err);
  expect(jobs.complete).not.toHaveBeenCalled();
});

test('tipo desconhecido e job já fechado por outro processo', async () => {
  jobs.claim.mockResolvedValueOnce([
    { id: 'j5', tenantId: 't1', kind: 'xyz' },
    { id: 'j6', tenantId: 't1', kind: 'inbound' },
  ]);
  jobs.load.mockImplementation(async (job) => (job.id === 'j6' ? null : { leadId: null, payload: {} }));
  const w = createWorker({ concurrency: 5, pollMs: 10000 });
  w.start();
  await flush();
  await w.idle();
  await w.stop();
  expect(jobs.fail).toHaveBeenCalledWith(expect.objectContaining({ id: 'j5' }), expect.objectContaining({ code: 'JOB_UNKNOWN_KIND' }));
  expect(conversation.handleInbound).not.toHaveBeenCalled(); // j6 sem linha: nada a fazer
  expect(jobs.complete).not.toHaveBeenCalled();
  jobs.load.mockReset();
  jobs.load.mockResolvedValue({ leadId: 'lead-1', payload: { waId: '5511900000000', text: 'oi' } });
});

test('respeita a concorrência: só pede à fila o que cabe', async () => {
  const gate = deferred();
  conversation.handleInbound.mockImplementation(() => gate.promise);
  jobs.claim.mockResolvedValueOnce([
    { id: 'a', tenantId: 't1', kind: 'inbound' },
    { id: 'b', tenantId: 't1', kind: 'inbound' },
  ]);
  const w = createWorker({ concurrency: 2, pollMs: 10000 });
  w.start();
  await flush();
  expect(jobs.claim).toHaveBeenNthCalledWith(1, 2);
  // Cheio: um aviso de job novo não reivindica mais nada.
  const calls = jobs.claim.mock.calls.length;
  jobs.events.emit('enqueued');
  await flush();
  expect(jobs.claim.mock.calls.length).toBe(calls);
  gate.resolve();
  await w.idle();
  await w.stop();
  conversation.handleInbound.mockReset();
  expect(jobs.complete).toHaveBeenCalledTimes(2);
});

test('stop espera o job em andamento terminar', async () => {
  const gate = deferred();
  conversation.handleInbound.mockImplementationOnce(() => gate.promise);
  jobs.claim.mockResolvedValueOnce([{ id: 'j7', tenantId: 't1', kind: 'inbound' }]);
  const w = createWorker({ concurrency: 1, pollMs: 10000 });
  w.start();
  await flush();
  let stopped = false;
  const stopping = w.stop(5000).then(() => {
    stopped = true;
  });
  await flush();
  expect(stopped).toBe(false);
  gate.resolve();
  await stopping;
  expect(stopped).toBe(true);
  expect(jobs.complete).toHaveBeenCalled();
});

test('falha ao reivindicar não derruba o worker', async () => {
  jobs.claim.mockRejectedValueOnce(Object.assign(new Error('db'), { code: 'ECONNREFUSED' }));
  const w = createWorker({ concurrency: 1, pollMs: 10000 });
  w.start();
  await flush();
  jobs.claim.mockResolvedValueOnce([{ id: 'j8', tenantId: 't1', kind: 'inbound' }]);
  jobs.events.emit('enqueued');
  await flush();
  await w.idle();
  await w.stop();
  expect(jobs.complete).toHaveBeenCalledWith(expect.objectContaining({ id: 'j8' }));
});

