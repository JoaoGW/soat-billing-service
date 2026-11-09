import { PrismaClient } from '@prisma/client';
import { RecoverBillingOutbox } from './recuperar-outbox';

describe('recuperação de evento de Billing', () => {
  const payload = { messageId: 'message-1', type: 'billing.quote-issued.v1', producer: 'soat-billing-service' };
  const message = { messageId: 'message-1', type: payload.type, payload, status: 'FAILED', claimOwner: null, claimUntil: null, publishedAt: null };
  const tx = { $queryRaw: jest.fn(), outbox: { findUnique: jest.fn(), updateMany: jest.fn() }, billingRecoveryAudit: { create: jest.fn() } };
  const db = { $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>) => fn(tx)) };
  const validate = jest.fn();
  const service = new RecoverBillingOutbox(db as unknown as PrismaClient, validate);
  const input = { messageId: 'message-1', actor: 'operator', reasonCode: 'BROKER_RECOVERED' };
  const now = new Date('2030-01-01T00:00:00Z');
  beforeEach(() => { jest.clearAllMocks(); tx.outbox.findUnique.mockResolvedValue(message); tx.outbox.updateMany.mockResolvedValue({ count: 1 }); validate.mockReturnValue(true); });

  it('audita e rearma sem modificar o conteúdo nem os identificadores', async () => {
    const id = await service.execute(input, now);
    expect(tx.billingRecoveryAudit.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ id, messageId: input.messageId, actor: input.actor, reasonCode: input.reasonCode, payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/) }) }));
    expect(tx.outbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'PENDING', attemptCount: 0, nextAttemptAt: now } }));
  });
  it('recusa dados incompletos ou inválidos antes de abrir transação', async () => {
    for (const invalid of [{ ...input, actor: '' }, { ...input, messageId: '../x' }, { ...input, reasonCode: 'texto livre' }, { ...input, actor: undefined }]) await expect(service.execute(invalid as typeof input, now)).rejects.toThrow();
    await expect(service.execute(input, new Date('invalid'))).rejects.toThrow();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each([null, { ...message, status: 'SENT' }, { ...message, claimOwner: 'worker' }, { ...message, claimUntil: now }, { ...message, publishedAt: now }])('recusa evento inexistente, publicado, reivindicado ou fora de FAILED', async row => {
    tx.outbox.findUnique.mockResolvedValue(row);
    await expect(service.execute(input, now)).rejects.toThrow('não elegível');
    expect(tx.billingRecoveryAudit.create).not.toHaveBeenCalled();
  });
  it.each([null, [], { ...payload, messageId: 'outro' }, { ...payload, type: 'outro' }, { ...payload, producer: 'outro' }])('recusa envelope divergente', async invalid => {
    tx.outbox.findUnique.mockResolvedValue({ ...message, payload: invalid });
    await expect(service.execute(input, now)).rejects.toThrow('Contrato');
    expect(tx.outbox.updateMany).not.toHaveBeenCalled();
  });
  it('recusa contrato inválido e disputa de atualização', async () => {
    validate.mockReturnValueOnce(false);
    await expect(service.execute(input, now)).rejects.toThrow('Contrato');
    tx.outbox.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.execute(input, now)).rejects.toThrow('mudou');
  });
});
