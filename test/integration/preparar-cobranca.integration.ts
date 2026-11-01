import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrepareChargeService } from '../../src/application/preparar-cobranca';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL de teste é obrigatória');
const target = new URL(url);
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('A integração exige banco local com nome terminado em _test');

describe('intenção de cobrança em PostgreSQL', () => {
  const prisma = new PrismaClient(); const service = new PrepareChargeService(prisma);
  const tag = randomUUID(); const now = new Date('2030-01-01T00:00:00Z');
  const input = { messageId: `msg-${tag}`, correlationId: 'correlation-1', clientId: 'client', totalInCents: 5123, currency: 'BRL', reservationId: 'reservation', operationId: `op-${tag}`, chargeId: `ch-${tag}`, quoteId: `q-${tag}`, quoteVersion: 1, osId: `os-${tag}`, sagaId: `s-${tag}`, filialId: 'branch', externalPosId: 'pos', expiresAt: '2030-01-01T00:15:00Z' };
  beforeAll(async () => {
    await prisma.quote.create({ data: { id: input.quoteId, osId: input.osId, sagaId: input.sagaId, filialId: input.filialId, clientId: 'client', version: 1, totalInCents: 5123, status: 'APPROVED', expiresAt: new Date('2030-01-02') } });
  });
  afterAll(async () => { await prisma.$disconnect(); });
  it('converge chamadas concorrentes da mesma operação para uma intenção e chave', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => service.execute(input, now)));
    expect(new Set(results.map((result) => result.providerKey)).size).toBe(1);
    expect(await prisma.charge.count({ where: { quoteId: input.quoteId } })).toBe(1);
    expect(await prisma.chargeAttempt.count({ where: { operationId: input.operationId } })).toBe(1);
    expect(await prisma.inbox.count({ where: { consumer: 'billing.create-charge.v1', messageId: input.messageId } })).toBe(1);
    await service.execute({ ...input, messageId: `retry-${tag}` }, now);
    expect(await prisma.inbox.count({ where: { consumer: 'billing.create-charge.v1', operationId: input.operationId } })).toBe(2);
    const charge = await prisma.charge.findUniqueOrThrow({ where: { id: input.chargeId } });
    expect(charge).toMatchObject({ status: 'INTENT_RECORDED', amountInCents: 5123, providerOrderId: null });
    await expect(service.execute({ ...input, externalPosId: 'changed' }, now)).rejects.toThrow('outro conteúdo');
  });
  it('impede outra operação de criar cobrança para o mesmo orçamento', async () => {
    await expect(service.execute({ ...input, messageId: `other-${tag}`, operationId: `other-${tag}`, chargeId: `other-${tag}` }, now)).rejects.toThrow('já existente');
    expect(await prisma.charge.count({ where: { quoteId: input.quoteId } })).toBe(1);
  });
});
