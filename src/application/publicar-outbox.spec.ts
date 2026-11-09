import { PrismaClient } from '@prisma/client';
import { MessagePublisher, OutboxDispatcher } from './publicar-outbox';

describe('OutboxDispatcher', () => {
  const item = { messageId: 'm1', type: 'billing.quote-issued.v1', payload: { id: 'q1' }, attemptCount: 0 };
  const prisma = { $queryRaw: jest.fn(), outbox: { updateMany: jest.fn() } };
  const publisher: MessagePublisher = { publish: jest.fn() };
  const dispatcher = new OutboxDispatcher(prisma as unknown as PrismaClient, publisher);
  const now = new Date('2030-01-01T00:00:00Z');
  beforeEach(() => { jest.resetAllMocks(); prisma.$queryRaw.mockResolvedValue([item]); prisma.outbox.updateMany.mockResolvedValue({ count: 1 }); });

  it('envia o ID persistido e confirma a publicação', async () => {
    await expect(dispatcher.dispatchOne(now)).resolves.toBe('SENT');
    expect(publisher.publish).toHaveBeenCalledWith({ messageId: 'm1', type: item.type, payload: item.payload });
    expect(prisma.outbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'SENT' }) }));
  });
  it('não publica quando não há trabalho', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(dispatcher.dispatchOne(now)).resolves.toBe('EMPTY');
    expect(publisher.publish).not.toHaveBeenCalled();
  });
  it('agenda nova tentativa com o mesmo ID após falha', async () => {
    jest.mocked(publisher.publish).mockRejectedValue(new Error('offline'));
    await expect(dispatcher.dispatchOne(now)).resolves.toBe('RETRY');
    expect(prisma.outbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING', attemptCount: 1, nextAttemptAt: new Date(now.getTime() + 1000) }) }));
  });
  it('sinaliza falha após cinco tentativas e não reconhece claim perdido', async () => {
    prisma.$queryRaw.mockResolvedValue([{ ...item, attemptCount: 4 }]);
    jest.mocked(publisher.publish).mockRejectedValue(new Error('offline'));
    await expect(dispatcher.dispatchOne(now)).resolves.toBe('FAILED');
    prisma.outbox.updateMany.mockResolvedValue({ count: 0 });
    await expect(dispatcher.dispatchOne(now)).resolves.toBe('CLAIM_LOST');
  });
});
