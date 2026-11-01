import { PrismaClient } from '@prisma/client';
import { ProcessMercadoPagoWebhook } from './processar-webhook';

describe('ProcessMercadoPagoWebhook', () => {
  const orderId = `ORD${'A'.repeat(26)}`;
  const context = { messageId: 'msg', correlationId: 'corr', sagaId: 'saga', filialId: 'branch', quoteId: 'quote', quoteVersion: 1, clientId: 'client', reservationId: 'reservation' };
  const charge = { id: 'charge', osId: 'os', quoteId: 'quote', providerOrderId: orderId, status: 'CREATED', amountInCents: 5001, currency: 'BRL', externalReference: 'charge', quote: { version: 1, clientId: 'client', sagaId: 'saga', filialId: 'branch' }, attempts: [{ operationId: 'op', status: 'CREATED', result: context }] };
  const notification = { status: 'RECEIVED', payload: { data: { id: orderId } } };
  const order = { id: orderId, type: 'qr', external_reference: 'charge', currency: 'BRL', total_amount: '50.01', status: 'processed', status_detail: 'accredited', transactions: { payments: [{ id: 'transaction', reference_id: '12345', status: 'processed', status_detail: 'accredited', paid_amount: '50.01' }] } };
  const detail = { id: 12345, status: 'approved', status_detail: 'accredited', currency_id: 'BRL', transaction_amount: 50.01, transaction_amount_refunded: 0, date_approved: '2030-01-01T12:00:00Z' };
  const tx = { $queryRaw: jest.fn(), charge: { findUniqueOrThrow: jest.fn(), update: jest.fn() }, receivedWebhook: { findUniqueOrThrow: jest.fn(), update: jest.fn() }, payment: { findUnique: jest.fn(), create: jest.fn() }, outbox: { create: jest.fn() } };
  const db = { receivedWebhook: { findUnique: jest.fn(), updateMany: jest.fn() }, charge: { findUnique: jest.fn() }, $transaction: jest.fn() };
  const provider = { get: jest.fn(), getPayment: jest.fn() };
  const service = new ProcessMercadoPagoWebhook(db as unknown as PrismaClient, provider);
  beforeEach(() => {
    jest.resetAllMocks(); db.receivedWebhook.findUnique.mockResolvedValue(notification); db.charge.findUnique.mockResolvedValue(charge);
    db.$transaction.mockImplementation(async (fn: (value: typeof tx) => unknown) => fn(tx));
    tx.charge.findUniqueOrThrow.mockResolvedValue(charge); tx.receivedWebhook.findUniqueOrThrow.mockResolvedValue(notification);
    provider.get.mockResolvedValue(order); provider.getPayment.mockResolvedValue(detail);
  });
  it('confirma apenas dados canônicos e grava pagamento, outbox e notificação juntos', async () => {
    await expect(service.execute('event')).resolves.toBe('APPLIED');
    expect(provider.get).toHaveBeenCalledWith(orderId); expect(provider.getPayment).toHaveBeenCalledWith('12345');
    expect(tx.payment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ providerPaymentId: '12345', paidAt: new Date('2030-01-01T12:00:00Z') }) }));
    expect(tx.outbox.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'billing.payment-confirmed.v1' }) }));
    expect(tx.charge.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'PAID' } }));
  });
  it('não confirma enquanto order está pendente ou cobrança local ainda não existe', async () => {
    db.charge.findUnique.mockResolvedValueOnce(null);
    await expect(service.execute('event')).resolves.toBe('PENDING');
    provider.get.mockResolvedValueOnce({ ...order, status: 'created' });
    await expect(service.execute('event')).resolves.toBe('PENDING');
    expect(tx.payment.create).not.toHaveBeenCalled();
  });
  it('exige reconciliação para dados divergentes e nunca publica pagamento', async () => {
    provider.get.mockResolvedValueOnce({ ...order, total_amount: '60.00' });
    await expect(service.execute('event')).resolves.toBe('RECONCILIACAO_NECESSARIA');
    provider.getPayment.mockResolvedValueOnce({ ...detail, currency_id: 'USD' });
    await expect(service.execute('event')).resolves.toBe('RECONCILIACAO_NECESSARIA');
    expect(tx.outbox.create).not.toHaveBeenCalled();
  });
  it('registra pagamento tardio após cancelamento, sem liberar execução', async () => {
    tx.charge.findUniqueOrThrow.mockResolvedValue({ ...charge, status: 'CANCELLED' });
    await expect(service.execute('event')).resolves.toBe('RECONCILIACAO_NECESSARIA');
    expect(tx.payment.create).toHaveBeenCalled(); expect(tx.outbox.create).not.toHaveBeenCalled();
    expect(tx.charge.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'RECONCILIACAO_NECESSARIA' } }));
  });
  it('não cria segundo pagamento em notificação repetida', async () => {
    tx.charge.findUniqueOrThrow.mockResolvedValue({ ...charge, status: 'PAID' });
    tx.payment.findUnique.mockResolvedValue({ id: 'p', chargeId: charge.id, amountInCents: 5001, currency: 'BRL' });
    await expect(service.execute('event')).resolves.toBe('APPLIED');
    expect(tx.payment.create).not.toHaveBeenCalled(); expect(tx.outbox.create).not.toHaveBeenCalled();
  });
  it('propaga indisponibilidade do provedor para repetição', async () => {
    provider.get.mockRejectedValueOnce(new Error('offline'));
    await expect(service.execute('event')).rejects.toThrow('offline');
    expect(tx.payment.create).not.toHaveBeenCalled();
  });
});
