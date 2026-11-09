import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BillingDatabase } from '../infrastructure/billing-database';
import { MercadoPagoWebhookController } from './mercado-pago-webhook-controller';

describe('ingresso de webhook Mercado Pago', () => {
  const original = process.env;
  const db = { receivedWebhook: { createMany: jest.fn() } };
  const secret = 'test-secret'; const dataId = 'ORD123'; const requestId = 'req'; const ts = '1234';
  const hash = createHmac('sha256', secret).update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex');
  const body = { type: 'order', action: 'order.processed', data: { id: dataId } };
  let app: INestApplication;
  beforeAll(async () => { const module = await Test.createTestingModule({ controllers: [MercadoPagoWebhookController], providers: [{ provide: BillingDatabase, useValue: db }] }).compile(); app = module.createNestApplication(); await app.init(); });
  afterAll(async () => { process.env = original; await app.close(); });
  beforeEach(() => { jest.resetAllMocks(); process.env = { ...original, ENABLE_MERCADO_PAGO_WEBHOOK: 'true', ENABLE_MERCADO_PAGO_WEBHOOK_PROCESSOR: 'true', MERCADO_PAGO_WEBHOOK_SECRET: secret }; db.receivedWebhook.createMany.mockResolvedValue({ count: 1 }); });
  const send = () => request(app.getHttpServer()).post('/webhooks/mercado-pago').query({ 'data.id': dataId }).set('x-signature', `ts=${ts},v1=${hash}`).set('x-request-id', requestId).send(body);
  it('fica indisponível por padrão e sem segredo', async () => {
    delete process.env.ENABLE_MERCADO_PAGO_WEBHOOK; await send().expect(503);
    process.env.ENABLE_MERCADO_PAGO_WEBHOOK = 'true'; delete process.env.MERCADO_PAGO_WEBHOOK_SECRET; await send().expect(503);
    expect(db.receivedWebhook.createMany).not.toHaveBeenCalled();
  });
  it('confirma somente após registrar notificação autenticada ou duplicada', async () => {
    await send().expect(200); db.receivedWebhook.createMany.mockResolvedValueOnce({ count: 0 }); await send().expect(200);
    expect(db.receivedWebhook.createMany).toHaveBeenCalledTimes(2);
  });
  it('rejeita assinatura inválida e dados inconsistentes', async () => {
    await request(app.getHttpServer()).post('/webhooks/mercado-pago').query({ 'data.id': dataId }).set('x-signature', 'invalid').set('x-request-id', requestId).send(body).expect(401);
    await request(app.getHttpServer()).post('/webhooks/mercado-pago').query({ 'data.id': dataId }).set('x-signature', `ts=${ts},v1=${hash}`).set('x-request-id', requestId).send({ ...body, data: { id: 'other' } }).expect(400);
    await request(app.getHttpServer()).post('/webhooks/mercado-pago').send(body).expect(400);
    expect(db.receivedWebhook.createMany).not.toHaveBeenCalled();
  });
  it('não confirma quando banco falha', async () => {
    db.receivedWebhook.createMany.mockRejectedValueOnce(new Error('offline')); await send().expect(503);
  });
});
