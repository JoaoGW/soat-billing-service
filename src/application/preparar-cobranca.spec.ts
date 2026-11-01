import { PrismaClient } from '@prisma/client';
import { PrepareChargeService } from './preparar-cobranca';

describe('PrepareChargeService', () => {
  const input = { operationId: 'op', chargeId: 'charge', quoteId: 'quote', quoteVersion: 1, osId: 'os', sagaId: 'saga', filialId: 'branch', externalPosId: 'pos', expiresAt: '2030-01-01T00:15:00Z' };
  const now = new Date('2030-01-01T00:00:00Z');
  const quote = { id: 'quote', version: 1, osId: 'os', sagaId: 'saga', filialId: 'branch', status: 'APPROVED', currency: 'BRL', totalInCents: 5000 };
  const tx = { $queryRaw: jest.fn(), quote: { findUnique: jest.fn() }, charge: { findFirst: jest.fn(), create: jest.fn() }, chargeAttempt: { findUnique: jest.fn(), create: jest.fn() } };
  const db = { $transaction: jest.fn() };
  const service = new PrepareChargeService(db as unknown as PrismaClient);
  beforeEach(() => {
    jest.resetAllMocks();
    db.$transaction.mockImplementation(async (callback: (transaction: typeof tx) => unknown) => callback(tx));
    tx.quote.findUnique.mockResolvedValue(quote);
  });
  it('grava cobrança e chave idempotente antes de qualquer chamada externa', async () => {
    const result = await service.execute(input, now);
    expect(result).toMatchObject({ chargeId: 'charge', status: 'INTENT_RECORDED' });
    expect(tx.charge.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amountInCents: 5000, externalReference: 'charge' }) }));
    expect(tx.chargeAttempt.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ operationId: 'op', providerKey: result.providerKey, status: 'INTENT_RECORDED' }) }));
  });
  it('reutiliza o resultado de operação idêntica e recusa alteração', async () => {
    await service.execute(input, now);
    const data = tx.chargeAttempt.create.mock.calls[0][0].data;
    tx.chargeAttempt.findUnique.mockResolvedValue({ ...data, charge: {} });
    await expect(service.execute(input, new Date('2040-01-01'))).resolves.toMatchObject({ chargeId: 'charge', providerKey: data.providerKey });
    await expect(service.execute({ ...input, externalPosId: 'other' }, now)).rejects.toThrow('outro conteúdo');
  });
  it('recusa orçamento não aprovado, outra cobrança e prazo expirado', async () => {
    tx.quote.findUnique.mockResolvedValueOnce({ ...quote, status: 'ISSUED' });
    await expect(service.execute(input, now)).rejects.toThrow('Orçamento');
    await expect(service.execute(input, new Date('2040-01-01'))).rejects.toThrow('expirado');
    tx.charge.findFirst.mockResolvedValue({ id: 'other' });
    await expect(service.execute(input, now)).rejects.toThrow('já existente');
    expect(tx.charge.create).not.toHaveBeenCalled();
  });
  it('valida comandos e repete conflito de serialização limitado', async () => {
    await expect(service.execute({ ...input, operationId: '../' }, now)).rejects.toThrow('inválidos');
    db.$transaction.mockRejectedValueOnce({ code: 'P2034' }).mockImplementation(async (callback: (transaction: typeof tx) => unknown) => callback(tx));
    await expect(service.execute(input, now)).resolves.toMatchObject({ status: 'INTENT_RECORDED' });
    expect(db.$transaction).toHaveBeenCalledTimes(2);
  });
});
