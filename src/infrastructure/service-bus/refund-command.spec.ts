import { PrismaClient } from '@prisma/client';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { RefundCommandConsumer, RefundCommandProcessor } from './refund-command';
import { PrepareRefundService, SubmitRefundService, ConfirmRefundService, RefundEvidenceMismatchError } from '../../application/reembolsar-pagamento';
describe('comando de reembolso', () => {
  const tx = { $executeRaw: jest.fn(), $queryRaw: jest.fn(), inbox: { updateMany: jest.fn() }, outbox: { create: jest.fn() } };
  const db = { $transaction: jest.fn(async (fn: (x: typeof tx) => Promise<void>) => fn(tx)), $queryRaw: jest.fn(), inbox: { findUnique: jest.fn(), updateMany: jest.fn() } };
  const validate = jest.fn(); const receiver = { completeMessage: jest.fn(), abandonMessage: jest.fn(), deadLetterMessage: jest.fn() };
  const body = { messageId: 'm', operationId: 'op', correlationId: 'c', osId: 'os', sagaId: 's', filialId: 'f', type: 'billing.refund-payment.v1', data: { refundId: 'r', paymentId: 'p', cancelOperationId: 'cancel', cancelEventId: 'e', reason: 'failure' } };
  const msg = { body, messageId: 'm', subject: body.type } as unknown as ServiceBusReceivedMessage;
  const prepare = { execute: jest.fn() }; const submit = { execute: jest.fn() }; const confirm = { execute: jest.fn() };
  const consumer = new RefundCommandConsumer(db as unknown as PrismaClient, validate);
  const processor = new RefundCommandProcessor(db as unknown as PrismaClient, prepare as unknown as PrepareRefundService, submit as unknown as SubmitRefundService, confirm as unknown as ConfirmRefundService, validate);
  beforeEach(() => { jest.resetAllMocks(); db.$transaction.mockImplementation(async (fn: (x: typeof tx) => Promise<void>) => fn(tx)); validate.mockReturnValue(true); tx.$queryRaw.mockResolvedValue([{ matches: true }]); tx.inbox.updateMany.mockResolvedValue({ count: 1 }); db.$queryRaw.mockResolvedValue([{ messageId: 'm', payload: body }]); db.inbox.findUnique.mockResolvedValue({}); prepare.execute.mockResolvedValue({}); submit.execute.mockResolvedValue('PENDING_CONFIRMATION'); confirm.execute.mockResolvedValue('REFUNDED'); });
  it('grava o comando antes do ACK e rejeita conteúdo inválido', async () => {
    await consumer.process(msg, receiver as unknown as ServiceBusReceiver); expect(receiver.completeMessage).toHaveBeenCalledTimes(1);
    validate.mockReturnValue(false); await consumer.process(msg, receiver as unknown as ServiceBusReceiver); expect(receiver.deadLetterMessage).toHaveBeenCalledTimes(1);
  });
  it('não envia pagamento sem evidência e confirma o resultado', async () => {
    db.inbox.findUnique.mockResolvedValueOnce(null); expect(await processor.processOne()).toBe('PENDING'); expect(submit.execute).not.toHaveBeenCalled();
    expect(await processor.processOne()).toBe('REFUNDED'); expect(submit.execute).toHaveBeenCalledWith('op'); expect(db.inbox.updateMany).toHaveBeenCalledTimes(1);
  });
  it('mantém resultado em voo sem tentar novo pedido', async () => {
    submit.execute.mockResolvedValue('IN_FLIGHT'); expect(await processor.processOne()).toBe('PENDING'); expect(confirm.execute).not.toHaveBeenCalled();
  });
  it('encaminha resposta financeira incerta à reconciliação sem confirmar nem repetir o reembolso', async () => {
    submit.execute.mockResolvedValue('RECONCILIACAO_NECESSARIA');
    expect(await processor.processOne()).toBe('RECONCILIACAO_NECESSARIA');
    expect(confirm.execute).not.toHaveBeenCalled();
    expect(tx.inbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'RECONCILIACAO_NECESSARIA' }) }));
    expect(tx.outbox.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ payload: expect.objectContaining({ data: expect.objectContaining({ reasonCode: 'PROVIDER_RESULT_UNKNOWN' }) }) }) }));
    expect(submit.execute).toHaveBeenCalledTimes(1);
  });
  it('mantém pendente uma falha anterior ao envio e nunca chama o provedor', async () => {
    prepare.execute.mockRejectedValue(new Error('banco indisponível'));
    expect(await processor.processOne()).toBe('PENDING');
    expect(submit.execute).not.toHaveBeenCalled();
    expect(confirm.execute).not.toHaveBeenCalled();
    expect(db.inbox.updateMany).not.toHaveBeenCalled();
  });
  it('avança após comando pendente e volta ao início ao esgotar a fila', async () => {
    const isolated = new RefundCommandProcessor(db as unknown as PrismaClient, prepare as unknown as PrepareRefundService, submit as unknown as SubmitRefundService, confirm as unknown as ConfirmRefundService, validate);
    const first = { messageId: 'a', payload: { ...body, messageId: 'a', operationId: 'op-a' } };
    const second = { messageId: 'b', payload: { ...body, messageId: 'b', operationId: 'op-b' } };
    db.$queryRaw.mockResolvedValueOnce([first]).mockResolvedValueOnce([second]).mockResolvedValueOnce([]).mockResolvedValueOnce([first]);
    prepare.execute.mockRejectedValueOnce(new Error('indisponível'));
    expect(await isolated.processOne()).toBe('PENDING');
    expect(await isolated.processOne()).toBe('REFUNDED');
    expect(await isolated.processOne()).toBe('REFUNDED');
    expect(db.$queryRaw.mock.calls.map(call => call[1])).toEqual(['', 'a', 'b', '']);
    expect(submit.execute.mock.calls.map(call => call[0])).toEqual(['op-b', 'op-a']);
  });
  it('registra evidência autenticada divergente para reconciliação sem chamar o provedor', async () => {
    prepare.execute.mockRejectedValue(new RefundEvidenceMismatchError());
    expect(await processor.processOne()).toBe('RECONCILIACAO_NECESSARIA');
    expect(tx.inbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'PENDING' }), data: expect.objectContaining({ status: 'RECONCILIACAO_NECESSARIA' }) }));
    expect(tx.outbox.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'billing.refund-blocked.v1' }) }));
    expect(submit.execute).not.toHaveBeenCalled();
    expect(confirm.execute).not.toHaveBeenCalled();
  });
  it('não publica conflito duplicado quando outro worker já o registrou', async () => {
    prepare.execute.mockRejectedValue(new RefundEvidenceMismatchError());
    tx.inbox.updateMany.mockResolvedValue({ count: 0 });
    expect(await processor.processOne()).toBe('RECONCILIACAO_NECESSARIA');
    expect(tx.outbox.create).not.toHaveBeenCalled();
  });
});
