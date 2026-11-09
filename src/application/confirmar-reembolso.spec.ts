import { PrismaClient } from '@prisma/client';
import { ConfirmRefundService } from './reembolsar-pagamento';

describe('confirmação de reembolso', () => {
  const orderId = `ORD${'A'.repeat(26)}`; const providerRefundId = `REF${'B'.repeat(26)}`;
  const quote = { id: 'q', version: 1, sagaId: 's', filialId: 'f' };
  const charge = { id: 'c', osId: 'os', quoteId: 'q', providerOrderId: orderId, externalReference: 'c', quote };
  const payment = { id: 'p', providerPaymentId: '123', currency: 'BRL', charge };
  const refund = { id: 'r', paymentId: 'p', status: 'PENDING_CONFIRMATION', providerRefundId, amountInCents: 5001, payment };
  const intent = { refundId: 'r', providerKey: 'key', messageId: 'm', correlationId: 'corr', sagaId: 's', filialId: 'f', cancelOperationId: 'cancel', cancelEventId: 'event', reason: 'SAGA_COMPENSATION' };
  const order = { id: orderId, type: 'qr', external_reference: 'c', currency: 'BRL', total_amount: '50.01', status: 'refunded', transactions: { payments: [{ id: 'tx', reference_id: '123', status: 'refunded', refunded_amount: '50.01' }], refunds: [{ id: providerRefundId, transaction_id: 'tx', status: 'processed', amount: '50.01' }] } };
  const tx = { $queryRaw: jest.fn(), refund: { findUniqueOrThrow: jest.fn(), update: jest.fn() }, charge: { update: jest.fn() }, outbox: { create: jest.fn() } };
  const db = { refund: { findUnique: jest.fn(), updateMany: jest.fn() }, commandOperation: { findUnique: jest.fn() }, $transaction: jest.fn() };
  const provider = { get: jest.fn() }; const service = new ConfirmRefundService(db as unknown as PrismaClient, provider);
  beforeEach(() => { jest.resetAllMocks(); db.refund.findUnique.mockResolvedValue(refund); db.commandOperation.findUnique.mockResolvedValue({ result: intent }); db.$transaction.mockImplementation(async (fn: (value: typeof tx) => unknown) => fn(tx)); tx.refund.findUniqueOrThrow.mockResolvedValue(refund); provider.get.mockResolvedValue(order); });
  it('confirma somente reembolso canônico e grava evento junto', async () => {
    await expect(service.execute('op')).resolves.toBe('REFUNDED');
    expect(tx.outbox.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'billing.payment-refunded.v1' }) }));
    expect(tx.refund.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'REFUNDED' } }));
    expect(tx.charge.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'REFUNDED' } }));
  });
  it('aguarda processamento ou exige reconciliação em dados divergentes', async () => {
    provider.get.mockResolvedValueOnce({ ...order, status: 'processed' }).mockResolvedValueOnce({ ...order, currency: 'USD' });
    await expect(service.execute('op')).resolves.toBe('PENDING_CONFIRMATION');
    await expect(service.execute('op')).resolves.toBe('RECONCILIACAO_NECESSARIA');
    expect(tx.outbox.create).not.toHaveBeenCalled();
  });
  it('reconhece confirmação anterior e falhas sem reenviar', async () => {
    db.refund.findUnique.mockResolvedValueOnce({ ...refund, status: 'REFUNDED' }).mockResolvedValueOnce(null);
    await expect(service.execute('op')).resolves.toBe('REFUNDED');
    await expect(service.execute('missing')).rejects.toThrow('não encontrado');
    expect(provider.get).not.toHaveBeenCalled();
  });
});
