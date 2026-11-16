import { PrismaClient } from '@prisma/client';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { RecoverBillingEvidenceDlq } from './recover-evidence-dlq';

describe('recuperação de evidência na DLQ', () => {
  const body = { messageId: 'msg-1', operationId: 'op-1', type: 'execution.work-cancelled.v1' };
  const message = { body, messageId: body.messageId, subject: body.type, applicationProperties: { signature: 'signed' } } as unknown as ServiceBusReceivedMessage;
  const db = { billingRecoveryAudit: { create: jest.fn() }, $queryRaw: jest.fn() };
  const verifier = { verify: jest.fn() }, validate = jest.fn(), receiver = { completeMessage: jest.fn() };
  const consumer = { process: jest.fn(async (msg: ServiceBusReceivedMessage, target: Pick<ServiceBusReceiver, 'completeMessage'>) => { await target.completeMessage(msg); }) };
  const service = new RecoverBillingEvidenceDlq(db as unknown as PrismaClient, verifier, validate, consumer as never);
  const input = { messageId: 'msg-1', actor: 'operator', reasonCode: 'BROKER_RESTORED' };
  beforeEach(() => { jest.clearAllMocks(); verifier.verify.mockReturnValue(true); validate.mockReturnValue(true); db.$queryRaw.mockResolvedValue([{ matches: true }]); });
  it('audita e confirma somente após persistência da evidência original', async () => {
    await expect(service.execute(message, receiver as never, input)).resolves.toBe('APPLIED');
    expect(db.billingRecoveryAudit.create).toHaveBeenCalledTimes(1);
    expect(consumer.process).toHaveBeenCalledTimes(1);
    expect(receiver.completeMessage).toHaveBeenCalledWith(message);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(receiver.completeMessage.mock.invocationCallOrder[0]);
  });
  it('recupera evidência de falha de execução pelo mesmo consumidor', async () => {
    const failed = { ...body, type: 'execution.work-failed.v1' };
    const failedMessage = { ...message, body: failed, subject: failed.type } as unknown as ServiceBusReceivedMessage;
    await expect(service.execute(failedMessage, receiver as never, input)).resolves.toBe('APPLIED');
    expect(db.billingRecoveryAudit.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'execution.work-failed.v1' }) });
    expect(receiver.completeMessage).toHaveBeenCalledWith(failedMessage);
  });
  it('recusa tipo fora da evidência ou subject divergente do envelope', async () => {
    const started = { ...body, type: 'execution.work-started.v1' };
    await expect(service.execute({ ...message, body: started, subject: started.type } as unknown as ServiceBusReceivedMessage, receiver as never, input)).rejects.toThrow('incompatível');
    await expect(service.execute({ ...message, subject: 'execution.work-failed.v1' } as unknown as ServiceBusReceivedMessage, receiver as never, input)).rejects.toThrow('incompatível');
    expect(db.billingRecoveryAudit.create).not.toHaveBeenCalled();
  });
  it('recusa assinatura, contrato e ID incorretos antes de auditar', async () => {
    verifier.verify.mockReturnValueOnce(false); await expect(service.execute(message, receiver as never, input)).rejects.toThrow();
    validate.mockReturnValueOnce(false); await expect(service.execute(message, receiver as never, input)).rejects.toThrow();
    await expect(service.execute(message, receiver as never, { ...input, messageId: 'other' })).rejects.toThrow();
    expect(db.billingRecoveryAudit.create).not.toHaveBeenCalled(); expect(receiver.completeMessage).not.toHaveBeenCalled();
  });
  it('não confirma se a auditoria ou a persistência falhar', async () => {
    db.billingRecoveryAudit.create.mockRejectedValueOnce(new Error('audit offline'));
    await expect(service.execute(message, receiver as never, input)).rejects.toThrow('audit offline');
    db.$queryRaw.mockResolvedValueOnce([{ matches: false }]);
    await expect(service.execute(message, receiver as never, input)).rejects.toThrow('não foi persistida');
    expect(receiver.completeMessage).not.toHaveBeenCalled();
  });
  it('não confirma quando o consumidor não confirma sua transação', async () => {
    consumer.process.mockResolvedValueOnce(undefined);
    await expect(service.execute(message, receiver as never, input)).rejects.toThrow('não foi persistida');
    expect(receiver.completeMessage).not.toHaveBeenCalled();
  });
});
