import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { NotificationDispatcher, QuoteNotifier } from '../../src/application/enviar-notificacao';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL de teste é obrigatória');
const target = new URL(url);
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('A integração exige banco local com nome terminado em _test');

describe('notificação durável em PostgreSQL', () => {
  const prisma = new PrismaClient();
  const now = new Date('2020-01-01T00:00:00Z');
  const tag = randomUUID();
  afterAll(async () => { await prisma.$disconnect(); });

  async function createTask(suffix: string, status = 'ISSUED') {
    const quoteId = `notification-quote-${suffix}-${tag}`;
    const id = `notification-${suffix}-${tag}`;
    await prisma.quote.create({ data: { id: quoteId, osId: `notification-os-${suffix}-${tag}`, sagaId: 'saga', filialId: 'filial', clientId: 'cliente', version: 1, totalInCents: 100, status, expiresAt: new Date('2035-01-01T00:00:00Z') } });
    await prisma.notification.create({ data: { id, quoteId, recipient: 'cliente@example.test', createdAt: now, nextAttemptAt: now } });
    return { id, quoteId };
  }

  it('distribui notificações entre workers e preserva o ID em retry', async () => {
    const first = await createTask('one');
    const second = await createTask('two');
    const sent: string[] = [];
    const notifier: QuoteNotifier = { send: async (message) => { sent.push(message.notificationId); await new Promise((resolve) => setTimeout(resolve, 20)); } };
    const workers = [new NotificationDispatcher(prisma, notifier), new NotificationDispatcher(prisma, notifier)];
    expect(await Promise.all(workers.map((worker) => worker.dispatchOne(now)))).toEqual(['SENT', 'SENT']);
    expect(sent.sort()).toEqual([first.id, second.id].sort());
    const retry = await createTask('retry');
    const attempts: string[] = [];
    const flaky: QuoteNotifier = { send: async (message) => { attempts.push(message.notificationId); if (attempts.length === 1) throw new Error('SMTP indisponível'); } };
    const worker = new NotificationDispatcher(prisma, flaky);
    await expect(worker.dispatchOne(now)).resolves.toBe('RETRY');
    await expect(worker.dispatchOne(new Date(now.getTime() + 1000))).resolves.toBe('SENT');
    expect(attempts).toEqual([retry.id, retry.id]);
  });

  it('não envia notificação para orçamento já decidido', async () => {
    const task = await createTask('approved', 'APPROVED');
    const notifier: QuoteNotifier = { send: jest.fn() };
    await expect(new NotificationDispatcher(prisma, notifier).dispatchOne(now)).resolves.toBe('SKIPPED');
    expect(notifier.send).not.toHaveBeenCalled();
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('SKIPPED');
  });
});
