import { PrismaClient } from '@prisma/client';

/** Sempre filtra pelo proprietário no banco; não retorna dados internos da tentativa. */
export class ChargeQueryService {
  constructor(private readonly db: PrismaClient) {}

  async execute(input: { chargeId?: string; osId?: string; clientId: string }, now = new Date()) {
    if (!input.clientId || Boolean(input.chargeId) === Boolean(input.osId) || !Number.isFinite(now.getTime())) throw new Error('Consulta inválida');
    const charge = await this.db.charge.findFirst({
      where: { ...(input.chargeId ? { id: input.chargeId } : { osId: input.osId }), quote: { clientId: input.clientId } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, osId: true, quoteId: true, status: true, amountInCents: true, currency: true, expiresAt: true, attempts: { where: { status: 'CREATED' }, orderBy: { createdAt: 'desc' }, take: 1, select: { result: true } } },
    });
    if (!charge) throw new Error('Cobrança não encontrada');
    const result = charge.attempts[0]?.result;
    const qrData = result && typeof result === 'object' && !Array.isArray(result) && typeof result.qrData === 'string' && result.qrData ? result.qrData : undefined;
    return { id: charge.id, osId: charge.osId, quoteId: charge.quoteId, status: charge.status, amountInCents: charge.amountInCents, currency: charge.currency, expiresAt: charge.expiresAt, ...(charge.status === 'CREATED' && charge.expiresAt > now && qrData ? { qrData } : {}) };
  }
}
