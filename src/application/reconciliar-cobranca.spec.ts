import { PrismaClient } from '@prisma/client';
import { ReconcileChargeFromWebhook } from './reconciliar-cobranca';

describe('reconciliação de cobrança por webhook', () => {
  const orderId = `ORD${'A'.repeat(26)}`, now = new Date('2030-01-01T00:00:00Z');
  const context = { fingerprint: 'fp', externalPosId: 'pos', messageId: 'msg', correlationId: 'corr', sagaId: 'saga', filialId: 'branch', quoteId: 'q', quoteVersion: 1, clientId: 'client', reservationId: 'res' };
  const attempt = { id: 'a', operationId: 'op', status: 'RECONCILIACAO_NECESSARIA', updatedAt: now, result: context };
  const charge = { id: 'charge', osId: 'os', externalReference: 'charge', providerOrderId: null, status: 'RECONCILIACAO_NECESSARIA', currency: 'BRL', amountInCents: 1000, expiresAt: new Date('2030-01-02'), quoteId: 'q', quote: { id: 'q', osId: 'os', sagaId: 'saga', filialId: 'branch', clientId: 'client', version: 1, totalInCents: 1000 }, attempts: [attempt] };
  const order = { id: orderId, type: 'qr', external_reference: 'charge', currency: 'BRL', total_amount: '10.00', status: 'processed' };
  const tx = { $queryRaw: jest.fn(), chargeAttempt: { updateMany: jest.fn() }, charge: { updateMany: jest.fn() }, outbox: { create: jest.fn() } };
  const db = { receivedWebhook: { findUnique: jest.fn() }, charge: { findUnique: jest.fn() }, $transaction: jest.fn() }; const provider = { get: jest.fn() };
  const service = new ReconcileChargeFromWebhook(db as unknown as PrismaClient, provider);
  beforeEach(() => { jest.resetAllMocks(); db.receivedWebhook.findUnique.mockResolvedValue({ status: 'RECEIVED', payload: { data: { id: orderId } } }); db.charge.findUnique.mockResolvedValueOnce(null).mockResolvedValue(charge); provider.get.mockResolvedValue(order); db.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx)); tx.chargeAttempt.updateMany.mockResolvedValue({ count: 1 }); tx.charge.updateMany.mockResolvedValue({ count: 1 }); });
  it('associa cobrança canônica e gera um evento sem criar outra order', async () => {
    await expect(service.execute('event', now)).resolves.toBe('RECOVERED');
    expect(provider.get).toHaveBeenCalledWith(orderId);
    expect(tx.outbox.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'billing.charge-created.v1' }) }));
  });
  it('não recupera order divergente, QR ausente ou chamada ainda em voo', async () => {
    provider.get.mockResolvedValueOnce({ ...order, currency: 'USD' }).mockResolvedValueOnce({ ...order, status: 'created' });
    await expect(service.execute('event', now)).resolves.toBe('PENDING');
    await expect(service.execute('event', now)).resolves.toBe('PENDING');
    db.charge.findUnique.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce({ ...charge, status: 'IN_FLIGHT', attempts: [{ ...attempt, status: 'IN_FLIGHT' }] });
    await expect(service.execute('event', now)).resolves.toBe('PENDING');
    expect(tx.outbox.create).not.toHaveBeenCalled();
  });
  it('não altera estado se outra execução venceu a disputa', async () => {
    tx.chargeAttempt.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.execute('event', now)).resolves.toBe('PENDING');
    expect(tx.charge.updateMany).not.toHaveBeenCalled();
  });
});
