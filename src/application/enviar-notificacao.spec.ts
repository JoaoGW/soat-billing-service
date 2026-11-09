import { PrismaClient } from '@prisma/client';
import { NotificationDispatcher, QuoteNotifier } from './enviar-notificacao';

describe('NotificationDispatcher', () => {
  const now = new Date('2030-01-01T00:00:00Z');
  const item = { id: 'notification-1', quoteId: 'quote-1', recipient: 'cliente@example.test', attemptCount: 0 };
  const quote = { id: 'quote-1', osId: 'os-1', status: 'ISSUED', expiresAt: new Date('2030-01-02T00:00:00Z') };
  const prisma = { $queryRaw: jest.fn(), quote: { findUnique: jest.fn() }, notification: { updateMany: jest.fn() } };
  const notifier: QuoteNotifier = { send: jest.fn() };
  const dispatcher = new NotificationDispatcher(prisma as unknown as PrismaClient, notifier);
  beforeEach(() => { jest.resetAllMocks(); prisma.$queryRaw.mockResolvedValue([item]); prisma.quote.findUnique.mockResolvedValue(quote); prisma.notification.updateMany.mockResolvedValue({ count: 1 }); });

  it('envia notificação apenas para orçamento vigente', async () => {
    await expect(dispatcher.dispatchOne(now)).resolves.toBe('SENT');
    expect(notifier.send).toHaveBeenCalledWith({ notificationId: item.id, recipient: item.recipient, quoteId: quote.id, osId: quote.osId });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'SENT' }) }));
  });
  it('ignora orçamento decidido ou expirado', async () => {
    prisma.quote.findUnique.mockResolvedValueOnce({ ...quote, status: 'APPROVED' }).mockResolvedValueOnce({ ...quote, expiresAt: now });
    await expect(dispatcher.dispatchOne(now)).resolves.toBe('SKIPPED');
    await expect(dispatcher.dispatchOne(now)).resolves.toBe('SKIPPED');
    expect(notifier.send).not.toHaveBeenCalled();
  });
  it('retenta falha de envio e sinaliza falha após cinco tentativas', async () => {
    jest.mocked(notifier.send).mockRejectedValue(new Error('offline'));
    await expect(dispatcher.dispatchOne(now)).resolves.toBe('RETRY');
    prisma.$queryRaw.mockResolvedValue([{ ...item, attemptCount: 4 }]);
    await expect(dispatcher.dispatchOne(now)).resolves.toBe('FAILED');
    expect(prisma.notification.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED', attemptCount: 5 }) }));
  });
  it('não envia sem tarefa e identifica claim perdido', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([]);
    await expect(dispatcher.dispatchOne(now)).resolves.toBe('EMPTY');
    prisma.notification.updateMany.mockResolvedValue({ count: 0 });
    await expect(dispatcher.dispatchOne(now)).resolves.toBe('CLAIM_LOST');
  });
});
