import { PrismaClient } from '@prisma/client';

export class QuoteQueryService {
  constructor(private readonly prisma: PrismaClient) {}

  async execute(quoteId: string, clientId: string) {
    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      select: {
        id: true, osId: true, clientId: true, version: true, status: true,
        totalInCents: true, currency: true, expiresAt: true,
        items: { select: { sourceId: true, itemType: true, description: true, quantity: true, unitPriceInCents: true } },
      },
    });
    if (!quote) throw new Error('Orçamento não encontrado');
    if (quote.clientId !== clientId) throw new Error('Acesso negado');
    const { clientId: _clientId, ...result } = quote;
    void _clientId;
    return result;
  }
}
