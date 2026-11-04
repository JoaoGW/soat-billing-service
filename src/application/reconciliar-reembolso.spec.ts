import { PrismaClient } from '@prisma/client';
import { ConfirmRefundService } from './reembolsar-pagamento';
import { ReconcileRefundService } from './reconciliar-reembolso';

describe('reconciliação de reembolso incerto', () => {
  const orderId = `ORD${'A'.repeat(26)}`; const refundId = `REF${'B'.repeat(26)}`; const now = new Date('2030-01-01T00:00:00Z');
  const refund = { id: 'r', status: 'RECONCILIACAO_NECESSARIA', updatedAt: new Date('2029-12-31T23:50:00Z'), providerRefundId: null, amountInCents: 5001, payment: { providerPaymentId: '123', charge: { providerOrderId: orderId, externalReference: 'c' } } };
  const order = { id: orderId, type: 'qr', external_reference: 'c', currency: 'BRL', total_amount: '50.01', status: 'refunded', transactions: { payments: [{ id: 'tx', reference_id: '123', status: 'refunded', refunded_amount: '50.01' }], refunds: [{ id: refundId, transaction_id: 'tx', status: 'processed', amount: '50.01' }] } };
  const db = { refund: { findUnique: jest.fn(), updateMany: jest.fn() } }; const provider = { get: jest.fn() };
  const service = new ReconcileRefundService(db as unknown as PrismaClient, provider);
  beforeEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); db.refund.findUnique.mockResolvedValue(refund); db.refund.updateMany.mockResolvedValue({ count: 1 }); provider.get.mockResolvedValue(order); jest.spyOn(ConfirmRefundService.prototype, 'execute').mockResolvedValue('REFUNDED'); });
  it('recupera somente o reembolso integral canônico e confirma sem enviar outro pedido', async () => {
    await expect(service.execute('op', now)).resolves.toBe('REFUNDED');
    expect(provider.get).toHaveBeenCalledWith(orderId);
    expect(db.refund.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'r', status: refund.status, updatedAt: refund.updatedAt }), data: { status: 'PENDING_CONFIRMATION', providerRefundId: refundId } }));
    expect(ConfirmRefundService.prototype.execute).toHaveBeenCalledWith('op');
  });
  it('não confirma valor divergente ou resposta ambígua', async () => {
    provider.get.mockResolvedValueOnce({ ...order, total_amount: '1.00' }).mockResolvedValueOnce({ ...order, transactions: { ...order.transactions, refunds: [...order.transactions.refunds, { ...order.transactions.refunds[0], id: `REF${'C'.repeat(26)}` }] } });
    await expect(service.execute('op', now)).resolves.toBe('RECONCILIACAO_NECESSARIA');
    await expect(service.execute('op', now)).resolves.toBe('RECONCILIACAO_NECESSARIA');
    expect(db.refund.updateMany).not.toHaveBeenCalled();
  });
  it('aguarda envio recente e respeita disputa de atualização', async () => {
    db.refund.findUnique.mockResolvedValueOnce({ ...refund, status: 'IN_FLIGHT', updatedAt: now });
    await expect(service.execute('op', now)).resolves.toBe('PENDING'); expect(provider.get).not.toHaveBeenCalled();
    db.refund.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.execute('op', now)).resolves.toBe('PENDING'); expect(ConfirmRefundService.prototype.execute).not.toHaveBeenCalled();
  });
});
