import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrepareChargeCancellation, CancelChargeService } from '../../src/application/cancelar-cobranca';
import { CancelChargeCommandConsumer, CancelChargeCommandProcessor, cancelChargeValidator } from '../../src/infrastructure/service-bus/cancel-charge-command';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const target = new URL(process.env.DATABASE_URL ?? '');
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('Banco local de teste obrigatório');

describe('cancelamento de cobrança com PostgreSQL', () => {
  const db = new PrismaClient();
  afterAll(async () => db.$disconnect());
  async function setup() {
    const tag = randomUUID(); const orderId = `ORD${randomUUID().replaceAll('-', '').slice(0, 26)}`;
    const input = { messageId: `msg-${tag}`, operationId: `op-${tag}`, correlationId: `corr-${tag}`, osId: `os-${tag}`, sagaId: `saga-${tag}`, filialId: 'branch', chargeId: `charge-${tag}`, reservationId: `reserve-${tag}`, cancelOperationId: `cancel-${tag}`, cancelEventId: `event-${tag}` };
    const quoteId = `quote-${tag}`;
    await db.inbox.create({ data: { consumer: 'billing.compensation-evidence', messageId: input.cancelEventId, operationId: input.cancelOperationId, type: 'execution.work-cancelled.v1', status: 'APPLIED', payload: { messageId: input.cancelEventId, type: 'execution.work-cancelled.v1', producer: 'soat-execution-service', operationId: input.cancelOperationId, osId: input.osId, sagaId: input.sagaId, filialId: input.filialId, data: { outcome: 'CANCELLED' } } } });
    await db.quote.create({ data: { id: quoteId, osId: input.osId, sagaId: input.sagaId, filialId: input.filialId, clientId: 'client', version: 1, totalInCents: 5001, status: 'APPROVED', expiresAt: new Date('2035-01-01') } });
    await db.charge.create({ data: { id: input.chargeId, quoteId, osId: input.osId, status: 'CREATED', amountInCents: 5001, currency: 'BRL', externalReference: input.chargeId, providerOrderId: orderId, expiresAt: new Date('2035-01-01'), attempts: { create: { id: `attempt-${tag}`, operationId: `charge-op-${tag}`, providerKey: `key-${tag}`, status: 'CREATED', result: { reservationId: input.reservationId, sagaId: input.sagaId, filialId: input.filialId } } } } });
    const payment = { id: `transaction-${tag}`, status: 'created', status_detail: 'created', paid_amount: '0.00' };
    const order = { id: orderId, type: 'qr', external_reference: input.chargeId, currency: 'BRL', total_amount: '50.01', status: 'created', status_detail: 'created', transactions: { payments: [payment] } };
    const canceled = { ...order, status: 'canceled', status_detail: 'canceled', transactions: { payments: [{ ...payment, status: 'canceled', status_detail: 'canceled_by_api' }] } };
    return { input, order, canceled };
  }
  it('registra intenção e confirma uma única vez após consulta canônica', async () => {
    const x = await setup(); const prepare = new PrepareChargeCancellation(db); await prepare.execute(x.input); await prepare.execute(x.input);
    await expect(prepare.execute({ ...x.input, reservationId: 'other' })).rejects.toThrow();
    const provider = { get: jest.fn().mockResolvedValueOnce(x.order).mockResolvedValue(x.canceled), cancel: jest.fn().mockResolvedValue({}) };
    const service = new CancelChargeService(db, provider);
    expect(await service.submit(x.input.messageId)).toBe('CANCELED');
    expect(await service.submit(x.input.messageId)).toBe('CANCELED');
    expect(await service.reconcile(x.input.messageId)).toBe('CANCELED');
    expect(provider.cancel).toHaveBeenCalledTimes(1);
    expect((await db.charge.findUniqueOrThrow({ where: { id: x.input.chargeId } })).status).toBe('CANCELED');
    const events = await db.outbox.findMany({ where: { type: 'billing.charge-canceled.v1', payload: { path: ['sagaId'], equals: x.input.sagaId } } });
    expect(events).toHaveLength(1);
    const dir = resolve(process.cwd(), 'docs/contracts/messages'); const ajv = addFormats(new Ajv());
    ajv.addSchema(JSON.parse(readFileSync(resolve(dir, 'envelope.schema.json'), 'utf8')));
    expect(ajv.validate(JSON.parse(readFileSync(resolve(dir, 'billing.charge-canceled.v1.schema.json'), 'utf8')), events[0].payload)).toBe(true);
  });
  it('reconcilia timeout sem reenviar cancelamento', async () => {
    const x = await setup(); await new PrepareChargeCancellation(db).execute(x.input);
    const provider = { get: jest.fn().mockResolvedValueOnce(x.order).mockResolvedValue(x.canceled), cancel: jest.fn().mockRejectedValue(new Error('timeout')) };
    const service = new CancelChargeService(db, provider);
    expect(await service.submit(x.input.messageId)).toBe('RECONCILIACAO_NECESSARIA');
    expect(await service.submit(x.input.messageId)).toBe('RECONCILIACAO_NECESSARIA');
    expect(await service.reconcile(x.input.messageId)).toBe('CANCELED');
    expect(provider.cancel).toHaveBeenCalledTimes(1);
  });
  it('não envia uma segunda mutação enquanto a primeira está em voo', async () => {
    const x = await setup(); await new PrepareChargeCancellation(db).execute(x.input);
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const provider = { get: jest.fn().mockResolvedValueOnce(x.order).mockResolvedValue(x.canceled), cancel: jest.fn(async () => { entered(); await waiting; return {}; }) };
    const service = new CancelChargeService(db, provider); const first = service.submit(x.input.messageId);
    await started;
    try { expect(await service.submit(x.input.messageId)).toBe('IN_FLIGHT'); } finally { release(); }
    expect(await first).toBe('CANCELED'); expect(provider.cancel).toHaveBeenCalledTimes(1);
  });
  it('recupera falha na gravação após cancelamento remoto sem reenviar', async () => {
    const x = await setup(); await new PrepareChargeCancellation(db).execute(x.input);
    const provider = { get: jest.fn().mockResolvedValueOnce(x.order).mockResolvedValue(x.canceled), cancel: jest.fn().mockResolvedValue({}) };
    const service = new CancelChargeService(db, provider);
    await db.$executeRawUnsafe("CREATE FUNCTION test_block_charge_cancel_outbox() RETURNS trigger AS $$ BEGIN IF NEW.type = 'billing.charge-canceled.v1' THEN RAISE EXCEPTION 'outbox indisponível'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql");
    await db.$executeRawUnsafe('CREATE TRIGGER test_block_charge_cancel_outbox BEFORE INSERT ON "Outbox" FOR EACH ROW EXECUTE FUNCTION test_block_charge_cancel_outbox()');
    try {
      expect(await service.submit(x.input.messageId)).toBe('RECONCILIACAO_NECESSARIA');
      expect((await db.charge.findUniqueOrThrow({ where: { id: x.input.chargeId } })).status).toBe('RECONCILIACAO_NECESSARIA');
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER test_block_charge_cancel_outbox ON "Outbox"');
      await db.$executeRawUnsafe('DROP FUNCTION test_block_charge_cancel_outbox()');
    }
    expect(await service.reconcile(x.input.messageId)).toBe('CANCELED');
    expect(provider.cancel).toHaveBeenCalledTimes(1);
  });
  it('recusa divergências de evidência e reserva antes de chamar provedor', async () => {
    const x = await setup(); const prepare = new PrepareChargeCancellation(db);
    await expect(prepare.execute({ ...x.input, reservationId: 'other' })).rejects.toThrow('Reserva');
    await db.inbox.update({ where: { consumer_messageId: { consumer: 'billing.compensation-evidence', messageId: x.input.cancelEventId } }, data: { status: 'PENDING' } });
    await expect(prepare.execute(x.input)).rejects.toThrow('Evidência');
    expect((await db.charge.findUniqueOrThrow({ where: { id: x.input.chargeId } })).status).toBe('CREATED');
  });
  it('não cancela order já paga nem publica sucesso', async () => {
    const x = await setup(); await new PrepareChargeCancellation(db).execute(x.input);
    const provider = { get: jest.fn().mockResolvedValue({ ...x.order, status: 'processed' }), cancel: jest.fn() };
    const service = new CancelChargeService(db, provider);
    expect(await service.submit(x.input.messageId)).toBe('RECONCILIACAO_NECESSARIA');
    expect(provider.cancel).not.toHaveBeenCalled();
    expect(await db.outbox.count({ where: { type: 'billing.charge-canceled.v1', payload: { path: ['sagaId'], equals: x.input.sagaId } } })).toBe(0);
  });
  it('pagamento concorrente impede confirmação e evento de cancelamento', async () => {
    const x = await setup(); await new PrepareChargeCancellation(db).execute(x.input);
    const provider = { get: jest.fn().mockResolvedValueOnce(x.order).mockResolvedValue(x.canceled), cancel: jest.fn(async () => {
      await db.payment.create({ data: { id: `payment-${randomUUID()}`, chargeId: x.input.chargeId, providerPaymentId: String(Date.now()), amountInCents: 5001, currency: 'BRL', paidAt: new Date() } }); return {};
    }) };
    const service = new CancelChargeService(db, provider);
    expect(await service.submit(x.input.messageId)).toBe('RECONCILIACAO_NECESSARIA');
    expect(await db.outbox.count({ where: { type: 'billing.charge-canceled.v1', payload: { path: ['sagaId'], equals: x.input.sagaId } } })).toBe(0);
    expect((await db.charge.findUniqueOrThrow({ where: { id: x.input.chargeId } })).status).toBe('RECONCILIACAO_NECESSARIA');
  });
  it('persiste comando antes do ACK e processa após evidência autenticada', async () => {
    const x = await setup();
    const { chargeId, reservationId, cancelOperationId, cancelEventId, ...header } = x.input;
    const body = { ...header, type: 'billing.cancel-charge.v1', schemaVersion: 1, occurredAt: new Date().toISOString(), producer: 'soat-os-service', aggregateType: 'saga', aggregateId: x.input.sagaId, aggregateVersion: 1, causationId: 'cause', data: { chargeId, reservationId, cancelOperationId, cancelEventId } };
    const validate = cancelChargeValidator(resolve(process.cwd(), 'docs/contracts/messages'));
    const receiver = { completeMessage: jest.fn(), abandonMessage: jest.fn(), deadLetterMessage: jest.fn() };
    const consumer = new CancelChargeCommandConsumer(db, validate);
    await consumer.process({ body, messageId: body.messageId } as ServiceBusReceivedMessage, receiver as unknown as ServiceBusReceiver);
    expect(receiver.completeMessage).toHaveBeenCalledTimes(1);
    expect((await db.inbox.findUniqueOrThrow({ where: { consumer_messageId: { consumer: 'billing.cancel-charge-staging', messageId: body.messageId } } })).status).toBe('PENDING');
    const provider = { get: jest.fn().mockResolvedValueOnce(x.order).mockResolvedValue(x.canceled), cancel: jest.fn().mockResolvedValue({}) };
    const processor = new CancelChargeCommandProcessor(db, new PrepareChargeCancellation(db), new CancelChargeService(db, provider), validate);
    (processor as unknown as { cursor: string }).cursor = body.messageId.slice(0, -1);
    expect(await processor.processOne()).toBe('CANCELED');
    expect(provider.cancel).toHaveBeenCalledTimes(1);
  });
});
