import { PrismaClient } from '@prisma/client';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { RecoverBillingRefundDlq } from './recover-refund-dlq';

describe('recuperação de comando de reembolso na DLQ', () => {
  const body = { messageId: 'msg-1', operationId: 'op-1', type: 'billing.refund-payment.v1' };
  const message = { body, messageId: body.messageId, subject: body.type, applicationProperties: { signature: 'signed' } } as unknown as ServiceBusReceivedMessage;
  const db = { billingRecoveryAudit: { create: jest.fn() }, $queryRaw: jest.fn() };
  const verifier = { verify: jest.fn() }, validate = jest.fn(), receiver = { completeMessage: jest.fn() };
  const consumer = { process: jest.fn(async (msg: ServiceBusReceivedMessage, target: Pick<ServiceBusReceiver, 'completeMessage'>) => { await target.completeMessage(msg); }) };
  const service = new RecoverBillingRefundDlq(db as unknown as PrismaClient, verifier, validate, consumer as never);
  const input = { messageId: 'msg-1', actor: 'operator', reasonCode: 'BROKER_RESTORED' };
  beforeEach(() => { jest.clearAllMocks(); verifier.verify.mockReturnValue(true); validate.mockReturnValue(true); db.$queryRaw.mockResolvedValue([{ matches: true }]); });
  it('audita e registra sem chamar provedor financeiro', async () => {
    await expect(service.execute(message, receiver as never, input)).resolves.toBe('STAGED');
    expect(db.billingRecoveryAudit.create).toHaveBeenCalledTimes(1);
    expect(consumer.process).toHaveBeenCalledTimes(1);
    expect(receiver.completeMessage).toHaveBeenCalledWith(message);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(receiver.completeMessage.mock.invocationCallOrder[0]);
  });
  it('recusa assinatura, contrato e ID incorretos antes de auditar', async () => {
    verifier.verify.mockReturnValueOnce(false); await expect(service.execute(message, receiver as never, input)).rejects.toThrow();
    validate.mockReturnValueOnce(false); await expect(service.execute(message, receiver as never, input)).rejects.toThrow();
    await expect(service.execute(message, receiver as never, { ...input, messageId: 'other' })).rejects.toThrow();
    expect(db.billingRecoveryAudit.create).not.toHaveBeenCalled(); expect(receiver.completeMessage).not.toHaveBeenCalled();
  });
  it('não confirma se auditoria ou persistência falhar', async () => {
    db.billingRecoveryAudit.create.mockRejectedValueOnce(new Error('audit offline'));
    await expect(service.execute(message, receiver as never, input)).rejects.toThrow('audit offline');
    db.$queryRaw.mockResolvedValueOnce([{ matches: false }]);
    await expect(service.execute(message, receiver as never, input)).rejects.toThrow('não foi persistido');
    expect(receiver.completeMessage).not.toHaveBeenCalled();
  });
  it('não confirma quando o consumidor não confirma sua transação', async () => {
    consumer.process.mockResolvedValueOnce(undefined);
    await expect(service.execute(message, receiver as never, input)).rejects.toThrow('não foi persistido');
    expect(receiver.completeMessage).not.toHaveBeenCalled();
  });
});
