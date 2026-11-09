import { PrismaClient } from '@prisma/client';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { QuoteGenerationRejected } from '../../application/gerar-orcamento';
import { RecoverBillingQuoteDlq } from './recover-quote-dlq';

describe('recuperação de comando de orçamento na DLQ', () => {
  const body = { messageId: 'msg-1', operationId: 'op-1', type: 'billing.generate-quote.v1' };
  const message = { body, messageId: body.messageId, subject: body.type, applicationProperties: { signature: 'signed' } } as unknown as ServiceBusReceivedMessage;
  const db = { billingRecoveryAudit: { create: jest.fn() }, inbox: { findUnique: jest.fn() }, commandOperation: { findUnique: jest.fn() } };
  const verifier = { verify: jest.fn() }, validate = jest.fn(), handler = { execute: jest.fn() }, receiver = { completeMessage: jest.fn() };
  const service = new RecoverBillingQuoteDlq(db as unknown as PrismaClient, verifier, validate, handler);
  const input = { messageId: 'msg-1', actor: 'operator', reasonCode: 'BROKER_RESTORED' };
  beforeEach(() => { jest.resetAllMocks(); verifier.verify.mockReturnValue(true); validate.mockReturnValue(true); db.inbox.findUnique.mockResolvedValue({ status: 'APPLIED', operationId: 'op-1' }); db.commandOperation.findUnique.mockResolvedValue({ operationId: 'op-1' }); });
  it('audita, usa o handler normal e confirma somente após persistência', async () => {
    await expect(service.execute(message, receiver as unknown as ServiceBusReceiver, input)).resolves.toBe('APPLIED');
    expect(db.billingRecoveryAudit.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ messageId: input.messageId, actor: input.actor, reasonCode: input.reasonCode }) }));
    expect(handler.execute).toHaveBeenCalledWith(body);
    expect(receiver.completeMessage).toHaveBeenCalledWith(message);
    expect(db.billingRecoveryAudit.create.mock.invocationCallOrder[0]).toBeLessThan(handler.execute.mock.invocationCallOrder[0]);
    expect(db.inbox.findUnique.mock.invocationCallOrder[0]).toBeLessThan(receiver.completeMessage.mock.invocationCallOrder[0]);
  });
  it('recusa assinatura, schema, seleção ou tipo incompatível sem auditar ou confirmar', async () => {
    verifier.verify.mockReturnValueOnce(false); await expect(service.execute(message, receiver as unknown as ServiceBusReceiver, input)).rejects.toThrow();
    validate.mockReturnValueOnce(false); await expect(service.execute(message, receiver as unknown as ServiceBusReceiver, input)).rejects.toThrow();
    await expect(service.execute(message, receiver as unknown as ServiceBusReceiver, { ...input, messageId: 'other' })).rejects.toThrow();
    await expect(service.execute({ ...message, subject: 'billing.create-charge.v1' }, receiver as unknown as ServiceBusReceiver, input)).rejects.toThrow();
    expect(db.billingRecoveryAudit.create).not.toHaveBeenCalled(); expect(receiver.completeMessage).not.toHaveBeenCalled();
  });
  it('não confirma se o handler ou a persistência falhar', async () => {
    handler.execute.mockRejectedValueOnce(new Error('database offline')); await expect(service.execute(message, receiver as unknown as ServiceBusReceiver, input)).rejects.toThrow();
    db.inbox.findUnique.mockResolvedValueOnce(null); await expect(service.execute(message, receiver as unknown as ServiceBusReceiver, input)).rejects.toThrow('persistido');
    expect(receiver.completeMessage).not.toHaveBeenCalled();
  });
  it('não executa nem confirma quando a auditoria estiver indisponível', async () => {
    db.billingRecoveryAudit.create.mockRejectedValueOnce(new Error('audit offline'));
    await expect(service.execute(message, receiver as unknown as ServiceBusReceiver, input)).rejects.toThrow('audit offline');
    expect(handler.execute).not.toHaveBeenCalled();
    expect(receiver.completeMessage).not.toHaveBeenCalled();
  });
  it('aceita rejeição de negócio somente depois da persistência da falha', async () => {
    handler.execute.mockRejectedValueOnce(new QuoteGenerationRejected('EXPIRED'));
    await expect(service.execute(message, receiver as unknown as ServiceBusReceiver, input)).resolves.toBe('APPLIED');
    expect(receiver.completeMessage).toHaveBeenCalledTimes(1);
  });
});
