import { PrismaClient } from '@prisma/client';
import { QuoteQueryService } from './consultar-orcamento';

describe('QuoteQueryService', () => {
  const prisma = { quote: { findUnique: jest.fn() } };
  const service = new QuoteQueryService(prisma as unknown as PrismaClient);
  beforeEach(() => jest.resetAllMocks());
  it('retorna o snapshot do orçamento para o cliente dono', async () => {
    prisma.quote.findUnique.mockResolvedValue({ id: 'q1', osId: 'o1', clientId: 'c1', version: 1, status: 'ISSUED', totalInCents: 100, currency: 'BRL', expiresAt: new Date('2035-01-01'), items: [] });
    const result = await service.execute('q1', 'c1');
    expect(result).toMatchObject({ id: 'q1', totalInCents: 100 });
    expect(result).not.toHaveProperty('clientId');
  });
  it('nega acesso cruzado e diferencia orçamento inexistente', async () => {
    prisma.quote.findUnique.mockResolvedValueOnce({ clientId: 'c1' }).mockResolvedValueOnce(null);
    await expect(service.execute('q1', 'outro')).rejects.toThrow('Acesso negado');
    await expect(service.execute('inexistente', 'c1')).rejects.toThrow('não encontrado');
  });
});
