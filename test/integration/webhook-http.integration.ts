import { createHmac, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { BillingDatabase } from '../../src/infrastructure/billing-database';
import { MercadoPagoWebhookController } from '../../src/interfaces/mercado-pago-webhook-controller';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL de teste é obrigatória');
const target = new URL(url);
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('A integração exige banco local com nome terminado em _test');

describe('webhook HTTP com PostgreSQL', () => {
  const db = new PrismaClient(); let app: INestApplication;
  const oldProcessor = process.env.ENABLE_MERCADO_PAGO_WEBHOOK_PROCESSOR; const oldEnabled = process.env.ENABLE_MERCADO_PAGO_WEBHOOK; const oldSecret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  beforeAll(async () => {
    process.env.ENABLE_MERCADO_PAGO_WEBHOOK = 'true'; process.env.ENABLE_MERCADO_PAGO_WEBHOOK_PROCESSOR = 'true'; process.env.MERCADO_PAGO_WEBHOOK_SECRET = 'test-secret';
    const module = await Test.createTestingModule({ controllers: [MercadoPagoWebhookController], providers: [{ provide: BillingDatabase, useValue: db }] }).compile();
    app = module.createNestApplication(); await app.init();
  });
  afterAll(async () => {
    await app.close(); await db.$disconnect();
    if (oldProcessor === undefined) delete process.env.ENABLE_MERCADO_PAGO_WEBHOOK_PROCESSOR; else process.env.ENABLE_MERCADO_PAGO_WEBHOOK_PROCESSOR = oldProcessor;
    if (oldEnabled === undefined) delete process.env.ENABLE_MERCADO_PAGO_WEBHOOK; else process.env.ENABLE_MERCADO_PAGO_WEBHOOK = oldEnabled;
    if (oldSecret === undefined) delete process.env.MERCADO_PAGO_WEBHOOK_SECRET; else process.env.MERCADO_PAGO_WEBHOOK_SECRET = oldSecret;
  });
  it('confirma entregas assinadas após persistir uma notificação sem criar pagamento', async () => {
    const id = `ORD${randomUUID().replaceAll('-', '')}`; const requestId = randomUUID(); const ts = '1234';
    const hash = createHmac('sha256', 'test-secret').update(`id:${id.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex');
    const body = { type: 'order', action: 'order.processed', data: { id } };
    const send = () => request(app.getHttpServer()).post('/webhooks/mercado-pago').query({ 'data.id': id }).set('x-request-id', requestId).set('x-signature', `ts=${ts},v1=${hash}`).send(body);
    const before = await db.payment.count();
    await Promise.all(Array.from({ length: 4 }, async () => send().expect(200)));
    const rows = await db.receivedWebhook.findMany({ where: { provider: 'mercado-pago-orders', payload: { path: ['data', 'id'], equals: id } } });
    expect(rows).toHaveLength(1); expect(rows[0].status).toBe('RECEIVED');
    expect(await db.payment.count()).toBe(before);
  });
});
