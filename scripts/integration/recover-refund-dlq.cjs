/* Usa somente broker e PostgreSQL locais, sem credenciais do provedor. */
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { ServiceBusClient } = require('@azure/service-bus');
const { RefundCommandConsumer, refundCommandValidator } = require('../../dist/infrastructure/service-bus/refund-command');
const { MessageSigner, MessageVerifier } = require('../../dist/infrastructure/service-bus/message-signature');
const { RecoverBillingRefundDlq } = require('../../dist/infrastructure/service-bus/recover-refund-dlq');
const url = process.env.DATABASE_URL, connection = process.env.SERVICE_BUS_TEST_CONNECTION_STRING;
if (!url || !['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname) || !new URL(url).pathname.endsWith('_test')) throw Error('Banco local de teste obrigatório');
if (!connection || !/^Endpoint=sb:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(connection) || !/UseDevelopmentEmulator=true/i.test(connection)) throw Error('Broker local obrigatório');
const db = new PrismaClient(), bus = new ServiceBusClient(connection), sender = bus.createSender('bdd.billing.commands');
const queue = bus.createReceiver('bdd.billing.commands', { receiveMode: 'peekLock' });
const dlq = bus.createReceiver('bdd.billing.commands', { receiveMode: 'peekLock', subQueueType: 'deadLetter' });
async function main() {
  const tag = randomUUID(), messageId = `msg-${tag}`, operationId = `op-${tag}`;
  const body = { messageId, operationId, type: 'billing.refund-payment.v1', schemaVersion: 1, occurredAt: new Date().toISOString(), producer: 'soat-os-service', aggregateType: 'saga', aggregateId: `saga-${tag}`, aggregateVersion: 1, osId: `os-${tag}`, sagaId: `saga-${tag}`, filialId: 'branch', correlationId: `corr-${tag}`, causationId: `cause-${tag}`, data: { refundId: `refund-${tag}`, paymentId: `payment-${tag}`, cancelOperationId: `cancel-${tag}`, cancelEventId: `evidence-${tag}`, reason: 'SAGA_COMPENSATION' } };
  const keys = generateKeyPairSync('ed25519');
  const signer = new MessageSigner(keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const verifier = new MessageVerifier(keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'soat-os-service');
  await sender.sendMessages({ messageId, subject: body.type, body, applicationProperties: { signature: signer.sign(body) } });
  const selected = await queue.receiveMessages(1, { maxWaitTimeInMs: 15000 });
  assert.equal(selected.length, 1); if (selected[0].messageId !== messageId) { await queue.abandonMessage(selected[0]); throw Error('Fila não isolada'); }
  await queue.deadLetterMessage(selected[0], { deadLetterReason: 'TestRecovery' });
  const messages = await dlq.receiveMessages(1, { maxWaitTimeInMs: 15000 });
  assert.equal(messages.length, 1); if (messages[0].messageId !== messageId) { await dlq.abandonMessage(messages[0]); throw Error('DLQ não isolada'); }
  const validate = refundCommandValidator(path.resolve('docs/contracts/messages'));
  const service = new RecoverBillingRefundDlq(db, verifier, validate, new RefundCommandConsumer(db, validate));
  const input = { messageId, actor: 'operator', reasonCode: 'BROKER_RESTORED' };
  await assert.rejects(() => service.execute({ ...messages[0], body: { ...body, osId: 'alterado' } }, dlq, input));
  assert.equal(await db.billingRecoveryAudit.count({ where: { messageId } }), 0);
  await assert.rejects(() => service.execute(messages[0], { completeMessage: async () => { throw Error('ACK incerto simulado'); } }, input), /ACK incerto/);
  assert.equal(await service.execute(messages[0], dlq, input), 'STAGED');
  assert.equal(await db.inbox.count({ where: { consumer: 'billing.refund-staging', messageId, status: 'PENDING' } }), 1);
  assert.equal(await db.billingRecoveryAudit.count({ where: { messageId } }), 2);
  assert.equal(await db.refund.count({ where: { operationId } }), 0);
  assert.equal(await db.inbox.count({ where: { consumer: 'billing.compensation-evidence', messageId: body.data.cancelEventId } }), 0);
  process.stdout.write('Comando de reembolso recuperado após ACK incerto; aguarda evidência sem chamar provedor.\n');
}
main().finally(async () => { await dlq.close(); await queue.close(); await sender.close(); await bus.close(); await db.$disconnect(); }).catch(error => { console.error(error.stack); process.exitCode = 1; });
