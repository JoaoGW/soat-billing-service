import { randomUUID, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { PrismaClient } from '@prisma/client';
import { ProcessMercadoPagoWebhook } from '../../src/application/processar-webhook';
import { MercadoPagoWebhookWorker } from '../../src/infrastructure/mercado-pago/webhook-worker';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL de teste é obrigatória');
const target = new URL(url);
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('A integração exige banco local com nome terminado em _test');

describe('processamento de webhook em PostgreSQL', () => {
  const prisma = new PrismaClient();
  afterAll(async () => { await prisma.$disconnect(); });
  async function setup(status = 'CREATED') {
    const tag = randomUUID(); const orderId = `ORD${randomUUID().replaceAll('-', '').slice(0, 26)}`; const paymentProviderId = String(randomInt(100000000000, 999999999999));
    const quoteId = `q-${tag}`; const chargeId = `c-${tag}`; const osId = `os-${tag}`; const sagaId = `saga-${tag}`; const eventId = `event-${tag}`;
    await prisma.quote.create({ data: { id: quoteId, osId, sagaId, filialId: 'branch', clientId: 'client', version: 1, totalInCents: 5001, status: 'APPROVED', expiresAt: new Date('2030-01-02') } });
    await prisma.charge.create({ data: { id: chargeId, quoteId, osId, status, amountInCents: 5001, currency: 'BRL', externalReference: chargeId, providerOrderId: orderId, expiresAt: new Date('2030-01-01T00:15:00Z') } });
    await prisma.chargeAttempt.create({ data: { id: `a-${tag}`, chargeId, operationId: `op-${tag}`, providerKey: `key-${tag}`, status: 'CREATED', result: { fingerprint: 'hash', externalPosId: 'pos', messageId: `msg-${tag}`, correlationId: `corr-${tag}`, sagaId, filialId: 'branch', quoteId, quoteVersion: 1, clientId: 'client', reservationId: 'reservation' } } });
    await prisma.receivedWebhook.create({ data: { provider: 'mercado-pago-orders', eventId, status: 'RECEIVED', payload: { type: 'order', action: 'order.processed', data: { id: orderId } } } });
    const order = { id: orderId, type: 'qr', external_reference: chargeId, currency: 'BRL', total_amount: '50.01', status: 'processed', status_detail: 'accredited', transactions: { payments: [{ id: `PAY-${tag}`, reference_id: paymentProviderId, status: 'processed', status_detail: 'accredited', paid_amount: '50.01' }] } };
    const detail = { id: Number(paymentProviderId), status: 'approved', status_detail: 'accredited', currency_id: 'BRL', transaction_amount: 50.01, transaction_amount_refunded: 0, date_approved: '2030-01-01T12:00:00Z' };
    const service = new ProcessMercadoPagoWebhook(prisma, { get: async () => order, getPayment: async () => detail });
    return { tag, eventId, chargeId, paymentProviderId, orderId, service, order, detail };
  }
  it('confirma pagamento uma vez em notificações concorrentes e valida evento', async () => {
    const x = await setup();
    const another = `event-again-${x.tag}`;
    await prisma.receivedWebhook.create({ data: { provider: 'mercado-pago-orders', eventId: another, status: 'RECEIVED', payload: { type: 'order', action: 'order.processed', data: { id: x.orderId } } } });
    const results = await Promise.all([x.service.execute(x.eventId), x.service.execute(another)]);
    expect(results).toEqual(['APPLIED', 'APPLIED']);
    expect(await prisma.payment.count({ where: { chargeId: x.chargeId } })).toBe(1);
    const events = await prisma.outbox.findMany({ where: { type: 'billing.payment-confirmed.v1', payload: { path: ['data', 'chargeId'], equals: x.chargeId } } });
    expect(events).toHaveLength(1);
    const dir = resolve(process.cwd(), 'docs/contracts/messages'); const ajv = new Ajv(); addFormats(ajv);
    ajv.addSchema(JSON.parse(readFileSync(resolve(dir, 'envelope.schema.json'), 'utf8')));
    expect(ajv.validate(JSON.parse(readFileSync(resolve(dir, 'billing.payment-confirmed.v1.schema.json'), 'utf8')), events[0].payload)).toBe(true);
  });
  it('retém pagamento tardio para reconciliação sem evento que libere trabalho', async () => {
    const x = await setup('CANCELLED');
    await expect(x.service.execute(x.eventId)).resolves.toBe('RECONCILIACAO_NECESSARIA');
    expect(await prisma.payment.count({ where: { chargeId: x.chargeId } })).toBe(1);
    expect(await prisma.outbox.count({ where: { type: 'billing.payment-confirmed.v1', payload: { path: ['data', 'chargeId'], equals: x.chargeId } } })).toBe(0);
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: x.chargeId } })).status).toBe('RECONCILIACAO_NECESSARIA');
  });
  it('reverte pagamento e estado quando outbox falha e permite reprocessar', async () => {
    const x = await setup();
    await prisma.$executeRawUnsafe("CREATE FUNCTION test_block_payment_outbox() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'outbox indisponível'; END; $$ LANGUAGE plpgsql");
    await prisma.$executeRawUnsafe('CREATE TRIGGER test_block_payment_outbox BEFORE INSERT ON "Outbox" FOR EACH ROW EXECUTE FUNCTION test_block_payment_outbox()');
    try {
      await expect(x.service.execute(x.eventId)).rejects.toThrow();
      expect(await prisma.payment.count({ where: { chargeId: x.chargeId } })).toBe(0);
      expect((await prisma.charge.findUniqueOrThrow({ where: { id: x.chargeId } })).status).toBe('CREATED');
      expect((await prisma.receivedWebhook.findUniqueOrThrow({ where: { provider_eventId: { provider: 'mercado-pago-orders', eventId: x.eventId } } })).status).toBe('RECEIVED');
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER test_block_payment_outbox ON "Outbox"');
      await prisma.$executeRawUnsafe('DROP FUNCTION test_block_payment_outbox()');
    }
    await expect(x.service.execute(x.eventId)).resolves.toBe('APPLIED');
  });
  it('processador opcional percorre notificações e confirma após consultas simuladas', async () => {
    const x = await setup();
    const previousFetch = global.fetch; const previousEnabled = process.env.ENABLE_MERCADO_PAGO_WEBHOOK_PROCESSOR; const previousToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith(`/orders/${x.orderId}`)) return new Response(JSON.stringify(x.order), { status: 200 });
      if (path.endsWith(`/payments/${x.paymentProviderId}`)) return new Response(JSON.stringify(x.detail), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    process.env.ENABLE_MERCADO_PAGO_WEBHOOK_PROCESSOR = 'true'; process.env.MERCADO_PAGO_ACCESS_TOKEN = 'test-token';
    const worker = new MercadoPagoWebhookWorker();
    try {
      worker.onModuleInit();
      let status = '';
      for (let i = 0; i < 150 && status !== 'APPLIED'; i++) {
        status = (await prisma.receivedWebhook.findUniqueOrThrow({ where: { provider_eventId: { provider: 'mercado-pago-orders', eventId: x.eventId } } })).status;
        if (status !== 'APPLIED') await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(status).toBe('APPLIED');
      expect(await prisma.payment.count({ where: { chargeId: x.chargeId } })).toBe(1);
    } finally {
      await worker.onApplicationShutdown(); global.fetch = previousFetch;
      if (previousEnabled === undefined) delete process.env.ENABLE_MERCADO_PAGO_WEBHOOK_PROCESSOR; else process.env.ENABLE_MERCADO_PAGO_WEBHOOK_PROCESSOR = previousEnabled;
      if (previousToken === undefined) delete process.env.MERCADO_PAGO_ACCESS_TOKEN; else process.env.MERCADO_PAGO_ACCESS_TOKEN = previousToken;
    }
  });

});
