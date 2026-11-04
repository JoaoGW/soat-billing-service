import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { PrismaClient } from '@prisma/client';
import { PrepareChargeService } from '../../src/application/preparar-cobranca';
import { SubmitChargeService } from '../../src/application/enviar-cobranca';
import { ReconcileChargeFromWebhook } from '../../src/application/reconciliar-cobranca';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL de teste é obrigatória');
const target = new URL(url);
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('A integração exige banco local com nome terminado em _test');

describe('envio de cobrança com intenção durável', () => {
  const prisma = new PrismaClient(); const prepare = new PrepareChargeService(prisma);
  const tag = randomUUID(); const orderId = `ORD${randomUUID().replaceAll('-', '').slice(0, 26)}`; const now = new Date('2030-01-01T00:00:00Z');
  const input = { messageId: `msg-${tag}`, correlationId: 'correlation-1', clientId: 'client', totalInCents: 5123, currency: 'BRL', reservationId: 'reservation', operationId: `op-${tag}`, chargeId: `ch-${tag}`, quoteId: `q-${tag}`, quoteVersion: 1, osId: `os-${tag}`, sagaId: `s-${tag}`, filialId: 'branch', externalPosId: 'pos', expiresAt: '2030-01-01T00:15:00Z' };
  beforeAll(async () => {
    await prisma.quote.create({ data: { id: input.quoteId, osId: input.osId, sagaId: input.sagaId, filialId: input.filialId, clientId: 'client', version: 1, totalInCents: 5123, status: 'APPROVED', expiresAt: new Date('2030-01-02') } });
    await prepare.execute(input, now);
  });
  afterAll(async () => { await prisma.$disconnect(); });
  it('só uma concorrente chama o provedor e as demais não reenviam', async () => {
    let entered!: () => void; let release!: () => void;
    const sending = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const provider = { create: jest.fn(async () => { entered(); await wait; return { id: orderId, type: 'qr', external_reference: input.chargeId, currency: 'BRL', total_amount: '51.23', status: 'created', type_response: { qr_data: 'qr-test' } }; }) };
    const service = new SubmitChargeService(prisma, provider);
    const first = service.execute(input.operationId, now);
    await sending;
    try {
      await expect(service.execute(input.operationId, now)).resolves.toBe('IN_FLIGHT');
      expect(provider.create).toHaveBeenCalledTimes(1);
    } finally { release(); }
    await expect(first).resolves.toBe('CREATED');
    await expect(service.execute(input.operationId, now)).resolves.toBe('CREATED');
    const events = await prisma.outbox.findMany({ where: { type: 'billing.charge-created.v1', payload: { path: ['data', 'chargeId'], equals: input.chargeId } } });
    expect(events).toHaveLength(1);
    const dir = resolve(process.cwd(), 'docs/contracts/messages');
    const ajv = new Ajv(); addFormats(ajv);
    ajv.addSchema(JSON.parse(readFileSync(resolve(dir, 'envelope.schema.json'), 'utf8')));
    expect(ajv.validate(JSON.parse(readFileSync(resolve(dir, 'billing.charge-created.v1.schema.json'), 'utf8')), events[0].payload)).toBe(true);
    expect(await prisma.charge.findUniqueOrThrow({ where: { id: input.chargeId } })).toMatchObject({ status: 'CREATED', providerOrderId: orderId });
  });
  it('não reenviará cobrança se outbox falhar após retorno do provedor', async () => {
    const next = { ...input, messageId: `failure-msg-${tag}`, operationId: `failure-op-${tag}`, chargeId: `failure-charge-${tag}`, quoteId: `failure-q-${tag}`, osId: `failure-os-${tag}`, sagaId: `failure-s-${tag}` };
    await prisma.quote.create({ data: { id: next.quoteId, osId: next.osId, sagaId: next.sagaId, filialId: next.filialId, clientId: next.clientId, version: 1, totalInCents: 5123, status: 'APPROVED', expiresAt: new Date('2030-01-02') } });
    await prepare.execute(next, now);
    const provider = { create: jest.fn(async () => ({ id: `ORD${randomUUID().replaceAll('-', '').slice(0, 26)}`, type: 'qr', external_reference: next.chargeId, currency: 'BRL', total_amount: '51.23', status: 'created', type_response: { qr_data: 'qr-test' } })) };
    const service = new SubmitChargeService(prisma, provider);
    await prisma.$executeRawUnsafe("CREATE FUNCTION test_block_charge_outbox() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'outbox indisponível'; END; $$ LANGUAGE plpgsql");
    await prisma.$executeRawUnsafe('CREATE TRIGGER test_block_charge_outbox BEFORE INSERT ON "Outbox" FOR EACH ROW EXECUTE FUNCTION test_block_charge_outbox()');
    try {
      await expect(service.execute(next.operationId, now)).rejects.toThrow();
      expect(await prisma.charge.findUniqueOrThrow({ where: { id: next.chargeId } })).toMatchObject({ status: 'IN_FLIGHT', providerOrderId: null });
      expect(await prisma.outbox.count({ where: { type: 'billing.charge-created.v1', payload: { path: ['data', 'chargeId'], equals: next.chargeId } } })).toBe(0);
      await expect(service.execute(next.operationId, now)).resolves.toBe('IN_FLIGHT');
      expect(provider.create).toHaveBeenCalledTimes(1);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER test_block_charge_outbox ON "Outbox"');
      await prisma.$executeRawUnsafe('DROP FUNCTION test_block_charge_outbox()');
    }
  });
  it('recupera order criada após timeout usando webhook e consulta canônica, sem nova cobrança', async () => {
    const next = { ...input, messageId: `timeout-msg-${tag}`, operationId: `timeout-op-${tag}`, chargeId: `timeout-charge-${tag}`, quoteId: `timeout-q-${tag}`, osId: `timeout-os-${tag}`, sagaId: `timeout-s-${tag}` };
    await prisma.quote.create({ data: { id: next.quoteId, osId: next.osId, sagaId: next.sagaId, filialId: next.filialId, clientId: next.clientId, version: 1, totalInCents: 5123, status: 'APPROVED', expiresAt: new Date('2030-01-02') } });
    await prepare.execute(next, now);
    const create = jest.fn().mockRejectedValue(new Error('timeout após criação'));
    expect(await new SubmitChargeService(prisma, { create }).execute(next.operationId, now)).toBe('RECONCILIACAO_NECESSARIA');
    const providerOrder = `ORD${randomUUID().replaceAll('-', '').slice(0, 26)}`; const eventId = `event-${tag}`;
    await prisma.receivedWebhook.create({ data: { provider: 'mercado-pago-orders', eventId, status: 'RECEIVED', payload: { type: 'order', data: { id: providerOrder } } } });
    const provider = { get: jest.fn().mockResolvedValue({ id: providerOrder, type: 'qr', external_reference: next.chargeId, currency: 'BRL', total_amount: '51.23', status: 'processed' }) };
    const service = new ReconcileChargeFromWebhook(prisma, provider);
    const results = await Promise.all([service.execute(eventId, now), service.execute(eventId, now)]);
    expect(results.sort()).toEqual(['PENDING', 'RECOVERED']);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await prisma.charge.findUniqueOrThrow({ where: { id: next.chargeId } })).toMatchObject({ status: 'CREATED', providerOrderId: providerOrder });
    expect(await prisma.outbox.count({ where: { type: 'billing.charge-created.v1', payload: { path: ['data', 'chargeId'], equals: next.chargeId } } })).toBe(1);
  });

});
