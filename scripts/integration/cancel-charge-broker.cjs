/* Local emulator only: verifies command/evidence delivery, not OS orchestration. */
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { ServiceBusClient } = require('@azure/service-bus');
const { MessageSigner, MessageVerifier } = require('../../dist/infrastructure/service-bus/message-signature');
const { CompensationEvidenceConsumer, evidenceValidator } = require('../../dist/infrastructure/service-bus/compensation-evidence');
const { CancelChargeCommandConsumer, CancelChargeCommandProcessor, cancelChargeValidator } = require('../../dist/infrastructure/service-bus/cancel-charge-command');
const { PrepareChargeCancellation, CancelChargeService } = require('../../dist/application/cancelar-cobranca');
const url = process.env.DATABASE_URL, connection = process.env.SERVICE_BUS_TEST_CONNECTION_STRING;
if (!url || !['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname) || !new URL(url).pathname.endsWith('_test')) throw Error('Banco local de teste obrigatório');
if (!connection || !/^Endpoint=sb:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(connection) || !/UseDevelopmentEmulator=true/i.test(connection)) throw Error('Broker local obrigatório');
const db = new PrismaClient(), bus = new ServiceBusClient(connection), sender = bus.createSender('bdd.billing.commands');
const queue = bus.createReceiver('bdd.billing.commands', { receiveMode: 'peekLock' });
const keys = producer => { const pair = generateKeyPairSync('ed25519'); return { signer: new MessageSigner(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()), verifier: new MessageVerifier(pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), producer) }; };
async function sendAndReceive(body, key) {
  await sender.sendMessages({ messageId: body.messageId, subject: body.type, body, applicationProperties: { signature: key.signer.sign(body) } });
  const messages = await queue.receiveMessages(1, { maxWaitTimeInMs: 15000 });
  assert.equal(messages.length, 1); if (messages[0].messageId !== body.messageId) { await queue.abandonMessage(messages[0]); throw Error('Fila não isolada'); }
  assert.equal(key.verifier.verify(messages[0].body, messages[0].applicationProperties?.signature), true);
  return messages[0];
}
async function main() {
  const tag = randomUUID(), sagaId = `saga-${tag}`, osId = `os-${tag}`, chargeId = `charge-${tag}`, quoteId = `quote-${tag}`, reservationId = `reservation-${tag}`, cancelOperationId = `work-cancel-${tag}`, cancelEventId = `evidence-${tag}`, orderId = `ORD${randomUUID().replaceAll('-', '').slice(0, 26)}`;
  const now = new Date().toISOString(), osKey = keys('soat-os-service'), executionKey = keys('soat-execution-service');
  const base = { schemaVersion: 1, occurredAt: now, aggregateVersion: 1, osId, sagaId, filialId: 'branch', correlationId: `corr-${tag}`, causationId: `cause-${tag}` };
  const command = { ...base, messageId: `msg-${tag}`, operationId: `op-${tag}`, type: 'billing.cancel-charge.v1', producer: 'soat-os-service', aggregateType: 'saga', aggregateId: sagaId, traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01', tracestate: 'vendor=state', data: { chargeId, reservationId, cancelOperationId, cancelEventId } };
  const evidence = { ...base, messageId: cancelEventId, operationId: cancelOperationId, type: 'execution.work-cancelled.v1', producer: 'soat-execution-service', aggregateType: 'execution', aggregateId: `execution-${tag}`, data: { outcome: 'CANCELLED', reason: 'SAGA_COMPENSATION' } };
  assert.equal(osKey.verifier.verify({ ...command, osId: 'forged' }, osKey.signer.sign(command)), false);
  assert.equal(executionKey.verifier.verify(evidence, osKey.signer.sign(evidence)), false);
  await db.quote.create({ data: { id: quoteId, osId, sagaId, filialId: 'branch', clientId: 'client', version: 1, totalInCents: 500, status: 'APPROVED', expiresAt: new Date(Date.now() + 900000) } });
  await db.charge.create({ data: { id: chargeId, quoteId, osId, status: 'CREATED', amountInCents: 500, externalReference: chargeId, providerOrderId: orderId, expiresAt: new Date(Date.now() + 900000), attempts: { create: { id: `attempt-${tag}`, operationId: `charge-op-${tag}`, providerKey: `key-${tag}`, status: 'CREATED', result: { reservationId, sagaId, filialId: 'branch' } } } } });
  const dir = path.resolve('docs/contracts/messages'), validate = cancelChargeValidator(dir);
  const pay = { id: `transaction-${tag}`, status: 'created', status_detail: 'created', paid_amount: '0.00' };
  const order = { id: orderId, type: 'qr', external_reference: chargeId, currency: 'BRL', total_amount: '5.00', status: 'created', transactions: { payments: [pay] } };
  const canceled = { ...order, status: 'canceled', status_detail: 'canceled', transactions: { payments: [{ ...pay, status: 'canceled', status_detail: 'canceled_by_api' }] } };
  let calls = 0, reads = 0; const provider = { get: async () => ++reads === 1 ? order : canceled, cancel: async () => { calls++; return {}; } };
  const consumer = new CancelChargeCommandConsumer(db, validate), processor = new CancelChargeCommandProcessor(db, new PrepareChargeCancellation(db), new CancelChargeService(db, provider), validate);
  await consumer.process(await sendAndReceive(command, osKey), queue);
  await consumer.process(await sendAndReceive(command, osKey), queue);
  assert.equal(await db.inbox.count({ where: { consumer: 'billing.cancel-charge-staging', messageId: command.messageId } }), 1);
  processor.cursor = command.messageId.slice(0, -1);
  assert.equal(await processor.processOne(), 'EMPTY'); assert.equal(calls, 0);
  await new CompensationEvidenceConsumer(db, executionKey.verifier, evidenceValidator(dir)).process(await sendAndReceive(evidence, executionKey), queue);
  processor.cursor = command.messageId.slice(0, -1);
  assert.equal(await processor.processOne(), 'CANCELED'); assert.equal(calls, 1);
  await consumer.process(await sendAndReceive(command, osKey), queue);
  processor.cursor = command.messageId.slice(0, -1);
  assert.equal(await processor.processOne(), 'EMPTY'); assert.equal(calls, 1);
  const events = await db.outbox.findMany({ where: { type: 'billing.charge-canceled.v1', payload: { path: ['sagaId'], equals: sagaId } } });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.traceparent, command.traceparent); assert.equal(events[0].payload.tracestate, command.tracestate);
  await db.outbox.deleteMany({ where: { messageId: events[0].messageId } });
  process.stdout.write('Comando e evidência assinados passaram pelo broker local; confirmação financeira registrada uma vez.\n');
}
main().finally(async () => { await queue.close(); await sender.close(); await bus.close(); await db.$disconnect(); }).catch(error => { console.error(error.stack); process.exitCode = 1; });
