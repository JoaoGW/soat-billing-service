import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { QuoteDecisionService } from './decidir-orcamento';

describe('QuoteDecisionService', () => {
  const quote = { id: 'q1', osId: 'os1', sagaId: 's1', filialId: 'f1', clientId: 'c1', version: 1, revision: 0, status: 'ISSUED', expiresAt: new Date('2035-01-01T00:00:00Z') };
  const input = { quoteId: 'q1', clientId: 'c1', version: 1, decision: 'APPROVED' as const, idempotencyKey: 'key1', correlationId: 'corr1' };
  const tx = {
    $queryRaw: jest.fn(),
    idempotencyRequest: { findUnique: jest.fn(), create: jest.fn() },
    quote: { findUnique: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn() },
    quoteDecision: { create: jest.fn() },
    outbox: { create: jest.fn() },
  };
  const prisma = { $transaction: jest.fn((fn: (arg: typeof tx) => unknown) => fn(tx)) };
  const service = new QuoteDecisionService(prisma as unknown as PrismaClient);

  beforeEach(() => {
    jest.clearAllMocks();
    tx.idempotencyRequest.findUnique.mockResolvedValue(null);
    tx.quote.findUnique.mockResolvedValue(quote);
    tx.quote.findFirst.mockResolvedValue({ id: 'q1' });
    tx.quote.updateMany.mockResolvedValue({ count: 1 });
  });

  it('registra decisão, outbox e idempotência na mesma transação', async () => {
    await expect(service.execute(input, new Date('2030-01-01T00:00:00Z'))).resolves.toEqual({ quoteId: 'q1', version: 1, decision: 'APPROVED' });
    expect(tx.quote.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'q1', revision: 0, status: 'ISSUED' } }));
    expect(tx.outbox.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'billing.quote-approved.v1' }) }));
    expect(tx.outbox.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ payload: expect.objectContaining({ aggregateVersion: 2 }) }) }));
    expect(tx.quoteDecision.create).toHaveBeenCalledTimes(1);
    expect(tx.idempotencyRequest.create).toHaveBeenCalledTimes(1);
  });

  it('não publica novamente se a decisão já foi aplicada', async () => {
    tx.quote.findUnique.mockResolvedValue({ ...quote, status: 'APPROVED', revision: 1 });
    await service.execute(input, new Date('2030-01-01T00:00:00Z'));
    expect(tx.outbox.create).not.toHaveBeenCalled();
    expect(tx.quoteDecision.create).not.toHaveBeenCalled();
    expect(tx.idempotencyRequest.create).toHaveBeenCalledTimes(1);
  });

  it('recusa acesso de outro cliente e uma versão substituída', async () => {
    await expect(service.execute({ ...input, clientId: 'other' })).rejects.toThrow('Acesso negado');
    tx.quote.findFirst.mockResolvedValue({ id: 'q2' });
    await expect(service.execute(input)).rejects.toThrow('Versão divergente');
    expect(tx.outbox.create).not.toHaveBeenCalled();
  });

  it('não salva uma decisão quando o CAS falha', async () => {
    tx.quote.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.execute(input, new Date('2030-01-01T00:00:00Z'))).rejects.toThrow('concorrência');
    expect(tx.quoteDecision.create).not.toHaveBeenCalled();
    expect(tx.outbox.create).not.toHaveBeenCalled();
  });

  it('reproduz a resposta da chave original e rejeita reutilização divergente', async () => {
    const requestHash = createHash('sha256').update(JSON.stringify({ version: 1, decision: 'APPROVED' })).digest('hex');
    tx.idempotencyRequest.findUnique.mockResolvedValue({ requestHash, response: { quoteId: 'q1', version: 1, decision: 'APPROVED' } });
    await expect(service.execute(input)).resolves.toEqual({ quoteId: 'q1', version: 1, decision: 'APPROVED' });
    await expect(service.execute({ ...input, decision: 'REJECTED' })).rejects.toThrow('idempotência');
    expect(tx.outbox.create).not.toHaveBeenCalled();
  });

  it('rejeita entrada inválida, orçamento ausente e status inesperado', async () => {
    await expect(service.execute({ ...input, idempotencyKey: '' })).rejects.toThrow('Entrada inválida');
    tx.quote.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...quote, status: 'UNKNOWN' });
    await expect(service.execute(input)).rejects.toThrow('não encontrado');
    await expect(service.execute(input)).rejects.toThrow('Estado inválido');
  });

  it('repete conflitos transacionais transitórios e não repete erros de negócio', async () => {
    prisma.$transaction.mockImplementationOnce(() => Promise.reject({ code: 'P2034' }));
    await expect(service.execute(input, new Date('2030-01-01T00:00:00Z'))).resolves.toMatchObject({ decision: 'APPROVED' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('repete falha de serialização do SQL bruto', async () => {
    prisma.$transaction.mockImplementationOnce(() => Promise.reject({ code: 'P2010', meta: { code: '40001' } }));
    await expect(service.execute(input, new Date('2030-01-01T00:00:00Z'))).resolves.toMatchObject({ decision: 'APPROVED' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});
