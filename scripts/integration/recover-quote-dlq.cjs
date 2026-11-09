/* Broker e PostgreSQL locais; sem credenciais ou chamadas ao Mercado Pago. */
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { ServiceBusClient } = require('@azure/service-bus');
const { GenerateQuoteService } = require('../../dist/application/gerar-orcamento');
const { createQuoteCommandValidator } = require('../../dist/infrastructure/service-bus/command-consumer');
const { MessageSigner, MessageVerifier } = require('../../dist/infrastructure/service-bus/message-signature');
const { RecoverBillingQuoteDlq } = require('../../dist/infrastructure/service-bus/recover-quote-dlq');

const url = process.env.DATABASE_URL, connection = process.env.SERVICE_BUS_TEST_CONNECTION_STRING;
if (!url || !['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname) || !new URL(url).pathname.endsWith('_test')) throw Error('Banco local de teste obrigatório');
if (!connection || !/^Endpoint=sb:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(connection) || !/UseDevelopmentEmulator=true/i.test(connection)) throw Error('Broker local obrigatório');
const db = new PrismaClient(), bus = new ServiceBusClient(connection);
const sender = bus.createSender('bdd.billing.commands');
const queue = bus.createReceiver('bdd.billing.commands', { receiveMode: 'peekLock' });
const dlq = bus.createReceiver('bdd.billing.commands', { receiveMode: 'peekLock', subQueueType: 'deadLetter' });
async function main() {
  const tag = randomUUID(); const messageId = `msg-${tag}`; const operationId = `op-${tag}`;
  const body = { messageId, operationId, type: 'billing.generate-quote.v1', schemaVersion: 1, occurredAt: new Date().toISOString(), producer: 'soat-os-service', aggregateType: 'saga', aggregateId: `saga-${tag}`, aggregateVersion: 1, osId: `os-${tag}`, sagaId: `saga-${tag}`, filialId: 'branch', correlationId: `corr-${tag}`, causationId: `cause-${tag}`, traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01', tracestate: 'vendor=state', data: { clienteId: `client-${tag}`, contato: 'cliente@example.test', diagnosisId: `diag-${tag}`, diagnosisVersion: 1, expiresAt: new Date(Date.now() + 3600000).toISOString(), items: [{ sourceId: 'part-1', itemType: 'PART', quantity: 1, unitPriceInCents: 1000 }] } };
  const keys = generateKeyPairSync('ed25519');
  const signer = new MessageSigner(keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const verifier = new MessageVerifier(keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'soat-os-service');
  await sender.sendMessages({ messageId, subject: body.type, body, applicationProperties: { signature: signer.sign(body) } });
  const selected = await queue.receiveMessages(1, { maxWaitTimeInMs: 15000 });
  assert.equal(selected.length, 1);
  if (selected[0].messageId !== messageId) { await queue.abandonMessage(selected[0]); throw Error('Fila de teste não está isolada'); }
  await queue.deadLetterMessage(selected[0], { deadLetterReason: 'TestRecovery' });
  const messages = await dlq.receiveMessages(1, { maxWaitTimeInMs: 15000 });
  assert.equal(messages.length, 1);
  if (messages[0].messageId !== messageId) { await dlq.abandonMessage(messages[0]); throw Error('DLQ de teste não está isolada'); }
  const service = new RecoverBillingQuoteDlq(db, verifier, createQuoteCommandValidator(path.resolve('docs/contracts/messages')), new GenerateQuoteService(db));
  const input = { messageId, actor: 'operator', reasonCode: 'BROKER_RESTORED' };
  await assert.rejects(() => service.execute(messages[0], dlq, { ...input, messageId: 'other' }));
  const forged = { ...body, data: { ...body.data, clienteId: 'other-client' } };
  await assert.rejects(() => service.execute({ ...messages[0], body: forged }, dlq, input));
  const invalid = { ...body, data: { ...body.data, items: [] } };
  await assert.rejects(() => service.execute({ ...messages[0], body: invalid, applicationProperties: { signature: signer.sign(invalid) } }, dlq, input));
  assert.equal(await db.billingRecoveryAudit.count({ where: { messageId } }), 0);
  await assert.rejects(() => service.execute(messages[0], { completeMessage: async () => { throw Error('ACK incerto simulado'); } }, input), /ACK incerto/);
  assert.equal(await db.quote.count({ where: { osId: body.osId } }), 1);
  assert.equal(await db.billingRecoveryAudit.count({ where: { messageId } }), 1);
  assert.equal(await service.execute(messages[0], dlq, input), 'APPLIED');
  assert.equal(await db.quote.count({ where: { osId: body.osId } }), 1);
  assert.equal(await db.billingRecoveryAudit.count({ where: { messageId } }), 2);
  const inbox = await db.inbox.findUniqueOrThrow({ where: { consumer_messageId: { consumer: 'billing.generate-quote.v1', messageId } } });
  assert.equal(inbox.operationId, operationId); assert.equal(inbox.status, 'APPLIED');
  const events = await db.outbox.findMany({ where: { payload: { path: ['causationId'], equals: messageId } } });
  assert.equal(events.length, 1); assert.equal(events[0].payload.traceparent, body.traceparent); assert.equal(events[0].payload.tracestate, body.tracestate);
  // O banco é local e descartável; não deixar este evento de fixture na jornada seguinte.
  await db.outbox.deleteMany({ where: { payload: { path: ['causationId'], equals: messageId } } });
  process.stdout.write('Comando assinado recuperado da DLQ após ACK incerto, sem duplicar orçamento.\n');
}
main().finally(async () => { await dlq.close(); await queue.close(); await sender.close(); await bus.close(); await db.$disconnect(); }).catch(error => { console.error(error.stack); process.exitCode = 1; });
