import { PrismaClient } from '@prisma/client';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { RefundCommandConsumer, RefundCommandProcessor } from './refund-command';
import { PrepareRefundService, SubmitRefundService, ConfirmRefundService } from '../../application/reembolsar-pagamento';
describe('comando de reembolso', () => {
  const tx = { $executeRaw: jest.fn(), $queryRaw: jest.fn() };
  const db = { $transaction: jest.fn(async (fn: (x: typeof tx) => Promise<void>) => fn(tx)), $queryRaw: jest.fn(), inbox: { findUnique: jest.fn(), updateMany: jest.fn() } };
  const validate = jest.fn(); const receiver = { completeMessage: jest.fn(), abandonMessage: jest.fn(), deadLetterMessage: jest.fn() };
  const body = { messageId: 'm', operationId: 'op', correlationId: 'c', osId: 'os', sagaId: 's', filialId: 'f', type: 'billing.refund-payment.v1', data: { refundId: 'r', paymentId: 'p', cancelOperationId: 'cancel', cancelEventId: 'e', reason: 'failure' } };
  const msg = { body, messageId: 'm', subject: body.type } as unknown as ServiceBusReceivedMessage;
  const prepare = { execute: jest.fn() }; const submit = { execute: jest.fn() }; const confirm = { execute: jest.fn() };
  const consumer = new RefundCommandConsumer(db as unknown as PrismaClient, validate);
  const processor = new RefundCommandProcessor(db as unknown as PrismaClient, prepare as unknown as PrepareRefundService, submit as unknown as SubmitRefundService, confirm as unknown as ConfirmRefundService, validate);
  beforeEach(() => { jest.resetAllMocks(); validate.mockReturnValue(true); tx.$queryRaw.mockResolvedValue([{ matches: true }]); db.$queryRaw.mockResolvedValue([{ messageId: 'm', payload: body }]); db.inbox.findUnique.mockResolvedValue({}); prepare.execute.mockResolvedValue({}); submit.execute.mockResolvedValue('PENDING_CONFIRMATION'); confirm.execute.mockResolvedValue('REFUNDED'); });
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
});
