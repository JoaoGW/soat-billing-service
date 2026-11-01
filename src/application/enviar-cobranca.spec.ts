import { PrismaClient } from '@prisma/client';
import { SubmitChargeService } from './enviar-cobranca';

describe('SubmitChargeService', () => {
  const orderId = `ORD${'A'.repeat(26)}`;
  const charge = { id: 'c1', osId: 'os', currency: 'BRL', amountInCents: 5001, externalReference: 'c1', expiresAt: new Date('2030-01-01T00:15:00Z') };
  const intent = { id: 'a1', chargeId: 'c1', providerKey: 'key1', status: 'INTENT_RECORDED', result: { fingerprint: 'hash', externalPosId: 'pos', messageId: 'msg', correlationId: 'corr', sagaId: 'saga', filialId: 'branch', quoteId: 'quote', quoteVersion: 1, clientId: 'client', reservationId: 'reservation' }, charge };
  const tx = { outbox: { create: jest.fn() }, charge: { updateMany: jest.fn(), update: jest.fn() }, chargeAttempt: { updateMany: jest.fn() } };
  const db = { chargeAttempt: { findUnique: jest.fn() }, $transaction: jest.fn() };
  const provider = { create: jest.fn() };
  const service = new SubmitChargeService(db as unknown as PrismaClient, provider);
  const now = new Date('2030-01-01T00:00:00Z');
  beforeEach(() => {
    jest.resetAllMocks();
    db.chargeAttempt.findUnique.mockResolvedValue(intent);
    db.$transaction.mockImplementation(async (fn: (value: typeof tx) => unknown) => fn(tx));
    tx.charge.updateMany.mockResolvedValue({ count: 1 }); tx.chargeAttempt.updateMany.mockResolvedValue({ count: 1 });
    provider.create.mockResolvedValue({ id: orderId, type: 'qr', external_reference: 'c1', currency: 'BRL', total_amount: '50.01', status: 'created', type_response: { qr_data: 'qr' } });
  });
  it('reivindica estado antes de criar e persiste retorno com chave original', async () => {
    await expect(service.execute('op', now)).resolves.toBe('CREATED');
    expect(provider.create).toHaveBeenCalledWith({ amountInCents: 5001, externalReference: 'c1', externalPosId: 'pos', idempotencyKey: 'key1', expirationMinutes: 15 });
    expect(tx.charge.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c1', status: 'INTENT_RECORDED' }, data: { status: 'IN_FLIGHT' } }));
    expect(tx.charge.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'CREATED', providerOrderId: orderId } }));
    expect(tx.outbox.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'billing.charge-created.v1' }) }));
  });
  it('não reenvia operação em voo nem após perda do claim', async () => {
    db.chargeAttempt.findUnique.mockResolvedValueOnce({ ...intent, status: 'IN_FLIGHT' });
    await expect(service.execute('op', now)).resolves.toBe('IN_FLIGHT');
    tx.charge.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.execute('op', now)).resolves.toBe('IN_FLIGHT');
    expect(provider.create).not.toHaveBeenCalled();
  });
  it('marca prazo expirado sem contatar provedor', async () => {
    await expect(service.execute('op', new Date('2030-01-01T00:15:00Z'))).resolves.toBe('EXPIRED');
    expect(provider.create).not.toHaveBeenCalled();
    expect(tx.outbox.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'billing.charge-failed.v1' }) }));
  });
  it('marca reconciliação em timeout ou resposta incompatível', async () => {
    provider.create.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({ id: orderId });
    await expect(service.execute('op', now)).resolves.toBe('RECONCILIACAO_NECESSARIA');
    await expect(service.execute('op', now)).resolves.toBe('RECONCILIACAO_NECESSARIA');
    expect(tx.charge.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'RECONCILIACAO_NECESSARIA' } }));
  });
  it('propaga erro do banco após envio para preservar intenção em voo', async () => {
    db.$transaction.mockImplementationOnce(async (fn: (value: typeof tx) => unknown) => fn(tx)).mockRejectedValueOnce(new Error('database offline'));
    await expect(service.execute('op', now)).rejects.toThrow('database offline');
    expect(provider.create).toHaveBeenCalledTimes(1);
  });
});
