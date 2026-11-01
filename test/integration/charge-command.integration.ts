import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { PrepareChargeService } from '../../src/application/preparar-cobranca';
import { SubmitChargeService } from '../../src/application/enviar-cobranca';
import { ChargeCommandConsumer, createChargeCommandValidator } from '../../src/infrastructure/service-bus/charge-consumer';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL de teste é obrigatória');
const target = new URL(url);
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('A integração exige banco local com nome terminado em _test');

describe('comando de cobrança com broker simulado', () => {
  const prisma = new PrismaClient();
  const tag = randomUUID(); const orderId = `ORD${randomUUID().replaceAll('-', '').slice(0, 26)}`;
  const dir = resolve(process.cwd(), 'docs/contracts/messages');
  const base = JSON.parse(readFileSync(resolve(dir, 'examples/billing.create-charge.v1.json'), 'utf8'));
  const event = { ...base, messageId: `msg-${tag}`, operationId: `op-${tag}`, osId: `os-${tag}`, sagaId: `saga-${tag}`, filialId: 'branch', data: { ...base.data, quoteId: `q-${tag}`, chargeId: `charge-${tag}`, clientId: 'client', totalInCents: 5123, externalPosId: 'pos', expiresAt: '2035-01-01T00:15:00Z' } };
  const provider = { create: jest.fn(async () => ({ id: orderId, type: 'qr', external_reference: event.data.chargeId, currency: 'BRL', total_amount: '51.23', status: 'created', type_response: { qr_data: 'qr' } })) };
  const receiver = { completeMessage: jest.fn(), abandonMessage: jest.fn(), deadLetterMessage: jest.fn() };
  const consumer = new ChargeCommandConsumer(new PrepareChargeService(prisma), new SubmitChargeService(prisma, provider), createChargeCommandValidator(dir));
  const message = { body: event, messageId: event.messageId, subject: event.type } as ServiceBusReceivedMessage;
  beforeAll(async () => { await prisma.quote.create({ data: { id: event.data.quoteId, osId: event.osId, sagaId: event.sagaId, filialId: event.filialId, clientId: 'client', version: 1, totalInCents: 5123, status: 'APPROVED', expiresAt: new Date('2035-01-01') } }); });
  afterAll(async () => { await prisma.$disconnect(); });
  it('grava inbox, intenção e evento antes de confirmar e não repete a cobrança', async () => {
    await consumer.process(message, receiver as unknown as ServiceBusReceiver);
    await consumer.process(message, receiver as unknown as ServiceBusReceiver);
    expect(receiver.completeMessage).toHaveBeenCalledTimes(2);
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(await prisma.inbox.count({ where: { consumer: 'billing.create-charge.v1', messageId: event.messageId } })).toBe(1);
    expect(await prisma.outbox.count({ where: { type: 'billing.charge-created.v1', payload: { path: ['data', 'chargeId'], equals: event.data.chargeId } } })).toBe(1);
  });
  it('registra falha de prazo antes do ACK sem chamar o provedor', async () => {
    const expired = { ...event, messageId: `expired-msg-${tag}`, operationId: `expired-op-${tag}`, osId: `expired-os-${tag}`, sagaId: `expired-saga-${tag}`, data: { ...event.data, quoteId: `expired-q-${tag}`, chargeId: `expired-charge-${tag}`, expiresAt: '2020-01-01T00:00:00Z' } };
    await prisma.quote.create({ data: { id: expired.data.quoteId, osId: expired.osId, sagaId: expired.sagaId, filialId: expired.filialId, clientId: 'client', version: 1, totalInCents: 5123, status: 'APPROVED', expiresAt: new Date('2035-01-01') } });
    const before = provider.create.mock.calls.length;
    const expiredMessage = { body: expired, messageId: expired.messageId, subject: expired.type } as ServiceBusReceivedMessage;
    await consumer.process(expiredMessage, receiver as unknown as ServiceBusReceiver);
    expect(receiver.completeMessage).toHaveBeenCalledWith(expiredMessage);
    expect(provider.create).toHaveBeenCalledTimes(before);
    expect(await prisma.outbox.count({ where: { type: 'billing.charge-failed.v1', payload: { path: ['data', 'chargeId'], equals: expired.data.chargeId } } })).toBe(1);
  });

});
