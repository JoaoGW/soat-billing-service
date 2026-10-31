import { PrismaClient } from '@prisma/client';
import { GenerateQuoteCommand, GenerateQuoteService } from './gerar-orcamento';

describe('GenerateQuoteService', () => {
  const command: GenerateQuoteCommand = { messageId: 'm1', operationId: 'op1', osId: 'os1', sagaId: 's1', filialId: 'f1', correlationId: 'c1', data: { clienteId: 'client', contato: 'x@example.test', diagnosisId: 'd1', diagnosisVersion: 1, expiresAt: '2035-01-01T00:00:00Z', items: [{ sourceId: 'p1', itemType: 'PART', quantity: 2, unitPriceInCents: 150 }] } };
  const now = new Date('2030-01-01T00:00:00Z');
  const tx = { inbox: { findUnique: jest.fn(), create: jest.fn() }, commandOperation: { findUnique: jest.fn(), create: jest.fn() }, quote: { findFirst: jest.fn(), create: jest.fn() }, outbox: { create: jest.fn() }, notification: { create: jest.fn() } };
  const prisma = { $transaction: jest.fn((fn: (arg: typeof tx) => unknown) => fn(tx)) };
  const service = new GenerateQuoteService(prisma as unknown as PrismaClient);
  beforeEach(() => { jest.clearAllMocks(); tx.inbox.findUnique.mockResolvedValue(null); tx.commandOperation.findUnique.mockResolvedValue(null); tx.quote.findFirst.mockResolvedValue(null); });

  it('cria orçamento, notificação, inbox e outbox em uma transação', async () => {
    const result = await service.execute(command, now);
    expect(result.version).toBe(1);
    expect(tx.quote.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ totalInCents: 300, clientId: 'client' }) }));
    expect(tx.outbox.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'billing.quote-issued.v1' }) }));
    expect(tx.notification.create).toHaveBeenCalledTimes(1);
    expect(tx.inbox.create).toHaveBeenCalledTimes(1);
    expect(tx.commandOperation.create).toHaveBeenCalledTimes(1);
  });

  it('trata reentrega da operação sem criar orçamento ou notificação novamente', async () => {
    const result = await service.execute(command, now);
    const calls = tx.commandOperation.create.mock.calls as unknown as [{ data: { payloadHash: string } }][];
    const payloadHash = calls[0][0].data.payloadHash;
    jest.clearAllMocks();
    tx.commandOperation.findUnique.mockResolvedValue({ payloadHash, result });
    tx.inbox.findUnique.mockResolvedValue({ operationId: command.operationId });
    await expect(service.execute(command, new Date('2040-01-01T00:00:00Z'))).resolves.toEqual(result);
    expect(tx.quote.create).not.toHaveBeenCalled();
    expect(tx.notification.create).not.toHaveBeenCalled();
    tx.inbox.findUnique.mockResolvedValue(null);
    await expect(service.execute({ ...command, messageId: 'm2' }, now)).resolves.toEqual(result);
    expect(tx.inbox.create).toHaveBeenCalledTimes(1);
  });

  it('rejeita operação alterada, mensagem inconsistente e orçamento já existente', async () => {
    tx.commandOperation.findUnique.mockResolvedValueOnce({ payloadHash: 'outro' });
    await expect(service.execute(command, now)).rejects.toThrow('outro conteúdo');
    tx.inbox.findUnique.mockResolvedValueOnce({ operationId: 'outra' });
    await expect(service.execute(command, now)).rejects.toThrow('outra operação');
    tx.quote.findFirst.mockResolvedValueOnce({ id: 'existing' });
    await expect(service.execute(command, now)).rejects.toThrow('já existente');
  });

  it('rejeita comandos inválidos ou expirados e tenta novamente conflitos', async () => {
    await expect(service.execute({ ...command, operationId: '' }, now)).rejects.toThrow('Comando inválido');
    await expect(service.execute(command, new Date('2040-01-01T00:00:00Z'))).rejects.toThrow('expirado');
    prisma.$transaction.mockImplementationOnce(() => Promise.reject({ code: 'P2034' }));
    await expect(service.execute(command, now)).resolves.toMatchObject({ version: 1 });
  });
});
