import { PrismaClient } from '@prisma/client';
import { PrepareRefundService, SubmitRefundService } from './reembolsar-pagamento';

describe('reembolso seguro', () => {
  const input = { correlationId: 'correlation1', messageId: 'm1', operationId: 'op1', refundId: 'r1', paymentId: 'p1', osId: 'os1', sagaId: 's1', filialId: 'f1', cancelOperationId: 'cancel1', cancelEventId: 'event1', reason: 'SAGA_COMPENSATION' };
  const orderId = `ORD${'A'.repeat(26)}`; const refundId = `REF${'B'.repeat(26)}`;
  const charge = { osId: 'os1', status: 'PAID', providerOrderId: orderId, externalReference: 'c1', quote: { sagaId: 's1', filialId: 'f1' } };
  const payment = { id: 'p1', amountInCents: 5001, currency: 'BRL', providerPaymentId: '123', charge };
  const order = { id: orderId, type: 'qr', external_reference: 'c1', currency: 'BRL', total_amount: '50.01', status: 'processed', status_detail: 'accredited', transactions: { payments: [{ id: 'transaction', reference_id: '123', status: 'processed', status_detail: 'accredited', paid_amount: '50.01' }] } };
  const tx = { $queryRaw: jest.fn(), inbox: { findUnique: jest.fn(), create: jest.fn() }, commandOperation: { findUnique: jest.fn(), create: jest.fn() }, payment: { findUnique: jest.fn() }, refund: { findFirst: jest.fn(), create: jest.fn() } };
  const db = { $transaction: jest.fn(), refund: { findUnique: jest.fn(), updateMany: jest.fn() }, commandOperation: { findUnique: jest.fn() } };
  const provider = { get: jest.fn(), refund: jest.fn() };
  const prepare = new PrepareRefundService(db as unknown as PrismaClient); const submit = new SubmitRefundService(db as unknown as PrismaClient, provider);
  beforeEach(() => {
    jest.resetAllMocks(); db.$transaction.mockImplementation(async (fn: (value: typeof tx) => unknown) => fn(tx)); tx.payment.findUnique.mockResolvedValue(payment);
    tx.inbox.findUnique.mockImplementation(async (query: { where: { consumer_messageId: { consumer: string } } }) => query.where.consumer_messageId.consumer === 'billing.compensation-evidence' ? { status: 'APPLIED', payload: { messageId: input.cancelEventId, type: 'execution.work-cancelled.v1', producer: 'soat-execution-service', operationId: input.cancelOperationId, osId: input.osId, sagaId: input.sagaId, filialId: input.filialId, data: { outcome: 'CANCELLED' } } } : null);
    db.refund.findUnique.mockResolvedValue({ id: 'r1', amountInCents: 5001, status: 'INTENT_RECORDED', payment });
    db.commandOperation.findUnique.mockResolvedValue({ result: { refundId: 'r1', providerKey: 'key1' } }); db.refund.updateMany.mockResolvedValue({ count: 1 });
    provider.get.mockResolvedValue(order); provider.refund.mockResolvedValue({ id: orderId, transactions: { refunds: [{ id: refundId, transaction_id: 'transaction', status: 'processing' }] } });
  });
  it('persiste intenção e chave antes de qualquer chamada', async () => {
    const result = await prepare.execute(input);
    expect(result).toMatchObject({ refundId: 'r1', cancelOperationId: 'cancel1', cancelEventId: 'event1' });
    expect(tx.refund.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amountInCents: 5001, status: 'INTENT_RECORDED' }) }));
    expect(tx.inbox.create).toHaveBeenCalled(); expect(provider.refund).not.toHaveBeenCalled();
  });
  it('deduplica operação e recusa pagamento ou conteúdo divergente', async () => {
    await prepare.execute(input); const previous = tx.commandOperation.create.mock.calls[0][0].data;
    tx.commandOperation.findUnique.mockResolvedValueOnce(previous);
    await expect(prepare.execute({ ...input, messageId: 'retry' })).resolves.toMatchObject({ refundId: 'r1' });
    tx.payment.findUnique.mockResolvedValueOnce({ ...payment, charge: { ...charge, osId: 'wrong' } });
    await expect(prepare.execute({ ...input, operationId: 'op2' })).rejects.toThrow('não permite');
    tx.refund.findFirst.mockResolvedValueOnce({ id: 'other' });
    await expect(prepare.execute({ ...input, operationId: 'op3' })).rejects.toThrow('já existente');
  });
  it('não prepara reembolso sem prova persistida de cancelamento sem início', async () => {
    tx.inbox.findUnique.mockResolvedValue(null);
    await expect(prepare.execute(input)).rejects.toThrow('Cancelamento sem confirmação');
    expect(tx.refund.create).not.toHaveBeenCalled(); expect(provider.refund).not.toHaveBeenCalled();
  });
  it('solicita uma vez e aguarda confirmação canônica', async () => {
    await expect(submit.execute('op1')).resolves.toBe('PENDING_CONFIRMATION');
    expect(provider.refund).toHaveBeenCalledWith(orderId, 'key1');
    expect(db.refund.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'PENDING_CONFIRMATION', providerRefundId: refundId } }));
  });
  it('não repete solicitação em voo ou após resultado incerto', async () => {
    db.refund.findUnique.mockResolvedValueOnce({ id: 'r1', status: 'IN_FLIGHT', payment });
    await expect(submit.execute('op1')).resolves.toBe('IN_FLIGHT');
    provider.refund.mockRejectedValueOnce(new Error('timeout'));
    await expect(submit.execute('op1')).resolves.toBe('RECONCILIACAO_NECESSARIA');
    expect(db.refund.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'RECONCILIACAO_NECESSARIA' } }));
  });
  it('não solicita estorno se a consulta canônica divergir', async () => {
    provider.get.mockResolvedValueOnce({ ...order, total_amount: '60.00' });
    await expect(submit.execute('op1')).resolves.toBe('RECONCILIACAO_NECESSARIA');
    expect(provider.refund).not.toHaveBeenCalled();
  });
  it('valida entradas e não aceita execução sem intenção', async () => {
    await expect(prepare.execute({ ...input, reason: '../' })).rejects.toThrow('inválido');
    db.refund.findUnique.mockResolvedValueOnce(null);
    await expect(submit.execute('missing')).rejects.toThrow('não encontrada');
  });
});
