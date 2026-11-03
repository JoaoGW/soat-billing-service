import { RefundCommandConsumer, RefundCommandProcessor, refundCommandValidator } from '../../src/infrastructure/service-bus/refund-command';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { randomUUID, randomInt } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { PrepareRefundService, SubmitRefundService, ConfirmRefundService } from '../../src/application/reembolsar-pagamento';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL de teste é obrigatória');
const target = new URL(url);
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('A integração exige banco local com nome terminado em _test');

describe('reembolso em PostgreSQL com provedor simulado', () => {
  const db = new PrismaClient(); const prepare = new PrepareRefundService(db);
  afterAll(async () => { await db.$disconnect(); });
  async function setup() {
    const tag = randomUUID(); const orderId = `ORD${randomUUID().replaceAll('-', '').slice(0, 26)}`; const providerRefundId = `REF${randomUUID().replaceAll('-', '').slice(0, 26)}`; const providerPaymentId = String(randomInt(100000000000, 999999999999));
    const input = { correlationId: 'correlation1', messageId: `msg-${tag}`, operationId: `op-${tag}`, refundId: `refund-${tag}`, paymentId: `payment-${tag}`, osId: `os-${tag}`, sagaId: `saga-${tag}`, filialId: 'branch', cancelOperationId: `cancel-${tag}`, cancelEventId: `event-${tag}`, reason: 'SAGA_COMPENSATION' };
    const quoteId = `q-${tag}`; const chargeId = `charge-${tag}`;
    await db.inbox.create({ data: { consumer: 'billing.compensation-evidence', messageId: input.cancelEventId, operationId: input.cancelOperationId, type: 'execution.work-cancelled.v1', status: 'APPLIED', payload: { messageId: input.cancelEventId, type: 'execution.work-cancelled.v1', producer: 'soat-execution-service', operationId: input.cancelOperationId, osId: input.osId, sagaId: input.sagaId, filialId: input.filialId, data: { outcome: 'CANCELLED' } } } });
    await db.quote.create({ data: { id: quoteId, osId: input.osId, sagaId: input.sagaId, filialId: input.filialId, clientId: 'client', version: 1, totalInCents: 5001, status: 'APPROVED', expiresAt: new Date('2035-01-01') } });
    await db.charge.create({ data: { id: chargeId, quoteId, osId: input.osId, status: 'PAID', amountInCents: 5001, currency: 'BRL', externalReference: chargeId, providerOrderId: orderId, expiresAt: new Date('2035-01-01') } });
    await db.payment.create({ data: { id: input.paymentId, chargeId, providerPaymentId, amountInCents: 5001, currency: 'BRL', paidAt: new Date('2030-01-01') } });
    const order = { id: orderId, type: 'qr', external_reference: chargeId, currency: 'BRL', total_amount: '50.01', status: 'processed', status_detail: 'accredited', transactions: { payments: [{ id: `transaction-${tag}`, reference_id: providerPaymentId, status: 'processed', status_detail: 'accredited', paid_amount: '50.01' }] } };
    const response = { id: orderId, transactions: { refunds: [{ id: providerRefundId, transaction_id: `transaction-${tag}`, status: 'processing' }] } };
    return { input, order, response, orderId, providerRefundId };
  }
  it('serializa intenção, usa chave única e não repete pedido em voo', async () => {
    const x = await setup(); const results = await Promise.all(Array.from({ length: 4 }, () => prepare.execute(x.input)));
    expect(new Set(results.map((item) => item.providerKey)).size).toBe(1);
    expect(await db.refund.count({ where: { paymentId: x.input.paymentId } })).toBe(1);
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { entered = resolve; });
    const provider = { get: jest.fn().mockResolvedValue(x.order), refund: jest.fn(async () => { entered(); await waiting; return x.response; }) };
    const submit = new SubmitRefundService(db, provider); const first = submit.execute(x.input.operationId);
    await started;
    try { await expect(submit.execute(x.input.operationId)).resolves.toBe('IN_FLIGHT'); } finally { release(); }
    await expect(first).resolves.toBe('PENDING_CONFIRMATION');
    expect(provider.refund).toHaveBeenCalledTimes(1);
    expect(await db.refund.findUniqueOrThrow({ where: { id: x.input.refundId } })).toMatchObject({ status: 'PENDING_CONFIRMATION', providerRefundId: x.providerRefundId });
    const refundedOrder = { ...x.order, status: 'refunded', transactions: { payments: [{ ...x.order.transactions.payments[0], status: 'refunded', refunded_amount: '50.01' }], refunds: [{ id: x.providerRefundId, transaction_id: x.order.transactions.payments[0].id, status: 'processed', amount: '50.01' }] } };
    const confirm = new ConfirmRefundService(db, { get: async () => refundedOrder });
    await db.$executeRawUnsafe("CREATE FUNCTION test_block_refund_outbox() RETURNS trigger AS $$ BEGIN IF NEW.type = 'billing.payment-refunded.v1' THEN RAISE EXCEPTION 'outbox indisponível'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql");
    await db.$executeRawUnsafe('CREATE TRIGGER test_block_refund_outbox BEFORE INSERT ON "Outbox" FOR EACH ROW EXECUTE FUNCTION test_block_refund_outbox()');
    try { await expect(confirm.execute(x.input.operationId)).rejects.toThrow(); expect((await db.refund.findUniqueOrThrow({ where: { id: x.input.refundId } })).status).toBe('PENDING_CONFIRMATION'); }
    finally { await db.$executeRawUnsafe('DROP TRIGGER test_block_refund_outbox ON "Outbox"'); await db.$executeRawUnsafe('DROP FUNCTION test_block_refund_outbox()'); }
    expect(await Promise.all(Array.from({ length: 3 }, () => confirm.execute(x.input.operationId)))).toEqual(['REFUNDED', 'REFUNDED', 'REFUNDED']);
    const events = await db.outbox.findMany({ where: { type: 'billing.payment-refunded.v1', payload: { path: ['data', 'refundId'], equals: x.input.refundId } } });
    expect(events).toHaveLength(1);
    const dir = resolve(process.cwd(), 'docs/contracts/messages'); const ajv = new Ajv(); addFormats(ajv); ajv.addSchema(JSON.parse(readFileSync(resolve(dir, 'envelope.schema.json'), 'utf8')));
    expect(ajv.validate(JSON.parse(readFileSync(resolve(dir, 'billing.payment-refunded.v1.schema.json'), 'utf8')), events[0].payload)).toBe(true);

  });
  it('não repete pedido quando persistência falha depois da resposta', async () => {
    const x = await setup(); await prepare.execute(x.input);
    const provider = { get: jest.fn().mockResolvedValue(x.order), refund: jest.fn().mockResolvedValue(x.response) }; const submit = new SubmitRefundService(db, provider);
    await db.$executeRawUnsafe("CREATE FUNCTION test_block_refund_update() RETURNS trigger AS $$ BEGIN IF NEW.status = 'PENDING_CONFIRMATION' THEN RAISE EXCEPTION 'banco offline'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql");
    await db.$executeRawUnsafe('CREATE TRIGGER test_block_refund_update BEFORE UPDATE ON "Refund" FOR EACH ROW EXECUTE FUNCTION test_block_refund_update()');
    try { await expect(submit.execute(x.input.operationId)).rejects.toThrow(); }
    finally { await db.$executeRawUnsafe('DROP TRIGGER test_block_refund_update ON "Refund"'); await db.$executeRawUnsafe('DROP FUNCTION test_block_refund_update()'); }
    await expect(submit.execute(x.input.operationId)).resolves.toBe('IN_FLIGHT');
    expect(provider.refund).toHaveBeenCalledTimes(1);
  });
  it('persiste comando antes do ACK e processa reembolso após evidência', async () => {
    const x = await setup();
    const body = { messageId: x.input.messageId, operationId: x.input.operationId, correlationId: x.input.correlationId, osId: x.input.osId, sagaId: x.input.sagaId, filialId: x.input.filialId, type: 'billing.refund-payment.v1', schemaVersion: 1, occurredAt: '2030-01-01T00:00:00Z', producer: 'soat-os-service', aggregateType: 'saga', aggregateId: x.input.sagaId, aggregateVersion: 1, causationId: 'cause', data: { refundId: x.input.refundId, paymentId: x.input.paymentId, cancelOperationId: x.input.cancelOperationId, cancelEventId: x.input.cancelEventId, reason: x.input.reason } };
    const validate = refundCommandValidator(resolve(process.cwd(), 'docs/contracts/messages')); const receiver = { completeMessage: jest.fn(), abandonMessage: jest.fn(), deadLetterMessage: jest.fn() };
    const message = { body, messageId: body.messageId } as unknown as ServiceBusReceivedMessage;
    await new RefundCommandConsumer(db, validate).process(message, receiver as unknown as ServiceBusReceiver);
    expect(receiver.completeMessage).toHaveBeenCalledTimes(1);
    const refundedOrder = { ...x.order, status: 'refunded', transactions: { payments: [{ ...x.order.transactions.payments[0], status: 'refunded', refunded_amount: '50.01' }], refunds: [{ id: x.providerRefundId, transaction_id: x.order.transactions.payments[0].id, status: 'processed', amount: '50.01' }] } };
    const provider = { get: jest.fn().mockResolvedValueOnce(x.order).mockResolvedValue(refundedOrder), refund: jest.fn().mockResolvedValue(x.response) };
    const processor = new RefundCommandProcessor(db, prepare, new SubmitRefundService(db, provider), new ConfirmRefundService(db, provider), validate);
    for (let i = 0; i < 100; i++) { await processor.processOne(); if ((await db.refund.findUnique({ where: { operationId: x.input.operationId } }))?.status === 'REFUNDED') break; }
    expect((await db.refund.findUniqueOrThrow({ where: { operationId: x.input.operationId } })).status).toBe('REFUNDED');
    expect(provider.refund).toHaveBeenCalledTimes(1);
  });

});
