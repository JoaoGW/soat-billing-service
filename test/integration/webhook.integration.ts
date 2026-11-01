import { randomUUID, createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { RegisterMercadoPagoWebhook } from '../../src/application/registrar-webhook';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL de teste é obrigatória');
const target = new URL(url);
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('A integração exige banco local com nome terminado em _test');

describe('registro de webhook em PostgreSQL', () => {
  const prisma = new PrismaClient();
  const service = new RegisterMercadoPagoWebhook(prisma, 'test-secret');
  afterAll(async () => { await prisma.$disconnect(); });
  it('deduplica notificações concorrentes sem confirmar pagamento', async () => {
    const dataId = `ORD${randomUUID().replaceAll('-', '')}`;
    const requestId = randomUUID(); const ts = '1234';
    const hash = createHmac('sha256', 'test-secret').update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex');
    const input = { dataId, requestId, signature: `ts=${ts},v1=${hash}`, body: { type: 'order', action: 'order.processed', data: { id: dataId, version: 1 } } };
    const paymentsBefore = await prisma.payment.count();
    const results = await Promise.all(Array.from({ length: 5 }, () => service.execute(input)));
    expect(results.filter((result) => result === 'RECORDED')).toHaveLength(1);
    expect(results.filter((result) => result === 'DUPLICATE')).toHaveLength(4);
    const records = await prisma.receivedWebhook.findMany({ where: { provider: 'mercado-pago-orders', payload: { path: ['data', 'id'], equals: dataId } } });
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('RECEIVED');
    expect(await prisma.payment.count()).toBe(paymentsBefore);
  });
});
