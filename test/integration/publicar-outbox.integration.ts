import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { MessagePublisher, OutboxDispatcher } from '../../src/application/publicar-outbox';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL de teste é obrigatória');
const target = new URL(url);
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('A integração exige banco local com nome terminado em _test');

describe('despacho da outbox em PostgreSQL', () => {
  const prisma = new PrismaClient();
  const now = new Date('2020-01-01T00:00:00Z');
  const tag = randomUUID();
  afterAll(async () => { await prisma.$disconnect(); });

  it('distribui mensagens entre workers e reenvia o mesmo ID após falha', async () => {
    const ids = [`one-${tag}`, `two-${tag}`];
    for (const id of ids) await prisma.outbox.create({ data: { messageId: id, type: 'test', payload: { id }, nextAttemptAt: now, createdAt: now } });
    const sent: string[] = [];
    const publisher: MessagePublisher = { publish: async (message) => { sent.push(message.messageId); await new Promise((resolve) => setTimeout(resolve, 20)); } };
    const workers = [new OutboxDispatcher(prisma, publisher), new OutboxDispatcher(prisma, publisher)];
    expect(await Promise.all(workers.map((worker) => worker.dispatchOne(now)))).toEqual(['SENT', 'SENT']);
    expect(sent.sort()).toEqual([...ids].sort());

    const retryId = `retry-${tag}`;
    await prisma.outbox.create({ data: { messageId: retryId, type: 'test', payload: {}, nextAttemptAt: now, createdAt: now } });
    const attempts: string[] = [];
    const flaky: MessagePublisher = { publish: async (message) => { attempts.push(message.messageId); if (attempts.length === 1) throw new Error('offline'); } };
    const worker = new OutboxDispatcher(prisma, flaky);
    await expect(worker.dispatchOne(now)).resolves.toBe('RETRY');
    await expect(worker.dispatchOne(now)).resolves.toBe('EMPTY');
    await expect(worker.dispatchOne(new Date(now.getTime() + 1000))).resolves.toBe('SENT');
    expect(attempts).toEqual([retryId, retryId]);
    expect((await prisma.outbox.findUniqueOrThrow({ where: { messageId: retryId } })).attemptCount).toBe(1);
  });

  it('recupera uma mensagem cujo claim expirou após interrupção', async () => {
    const id = `expired-${tag}`;
    await prisma.outbox.create({ data: { messageId: id, type: 'test', payload: {}, nextAttemptAt: now, createdAt: now, claimOwner: 'worker-interrompido', claimUntil: new Date(now.getTime() - 1) } });
    const publisher: MessagePublisher = { publish: jest.fn().mockResolvedValue(undefined) };
    await expect(new OutboxDispatcher(prisma, publisher).dispatchOne(now)).resolves.toBe('SENT');
    expect(publisher.publish).toHaveBeenCalledWith(expect.objectContaining({ messageId: id }));
  });
});
