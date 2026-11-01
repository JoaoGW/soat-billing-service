import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';

export interface PrepareCharge {
  operationId: string; chargeId: string; quoteId: string; quoteVersion: number;
  osId: string; sagaId: string; filialId: string; externalPosId: string; expiresAt: string;
}

/** Persists an intent only. A separately claimed operation must call the provider. */
export class PrepareChargeService {
  constructor(private readonly db: PrismaClient) {}
  async execute(input: PrepareCharge, now = new Date()): Promise<{ chargeId: string; providerKey: string; status: string }> {
    const identifiers = [input.operationId, input.chargeId, input.quoteId, input.osId, input.sagaId, input.filialId, input.externalPosId];
    if (identifiers.some((id) => typeof id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(id)) ||
        !Number.isSafeInteger(input.quoteVersion) || input.quoteVersion < 1 || !Number.isFinite(now.getTime()) ||
        !Number.isFinite(Date.parse(input.expiresAt))) throw new Error('Dados da cobrança inválidos');
    const expiresAt = new Date(input.expiresAt);
    const fingerprint = createHash('sha256').update(JSON.stringify({ operationId: input.operationId, chargeId: input.chargeId, quoteId: input.quoteId, quoteVersion: input.quoteVersion, osId: input.osId, sagaId: input.sagaId, filialId: input.filialId, externalPosId: input.externalPosId, expiresAt: expiresAt.toISOString() })).digest('hex');
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.$transaction(async (tx) => {
          // Serialize all new charge attempts against the same quote.
          await tx.$queryRaw`SELECT "id" FROM "Quote" WHERE "id" = ${input.quoteId} FOR UPDATE`;
          const prior = await tx.chargeAttempt.findUnique({ where: { operationId: input.operationId }, include: { charge: true } });
          if (prior) {
            const result = prior.result as { fingerprint?: string } | null;
            if (result?.fingerprint !== fingerprint) throw new Error('Operação reutilizada com outro conteúdo');
            return { chargeId: prior.chargeId, providerKey: prior.providerKey, status: prior.status };
          }
          const quote = await tx.quote.findUnique({ where: { id: input.quoteId } });
          if (!quote || quote.version !== input.quoteVersion || quote.osId !== input.osId || quote.sagaId !== input.sagaId || quote.filialId !== input.filialId || quote.status !== 'APPROVED' || quote.currency !== 'BRL' || quote.totalInCents <= 0) throw new Error('Orçamento não permite cobrança');
          if (expiresAt <= now) throw new Error('Prazo de cobrança expirado');
          if (await tx.charge.findFirst({ where: { quoteId: input.quoteId }, select: { id: true } })) throw new Error('Cobrança já existente para o orçamento');
          const providerKey = randomUUID();
          await tx.charge.create({ data: { id: input.chargeId, quoteId: quote.id, osId: quote.osId, status: 'INTENT_RECORDED', amountInCents: quote.totalInCents, currency: quote.currency, externalReference: input.chargeId, expiresAt } });
          await tx.chargeAttempt.create({ data: { id: randomUUID(), chargeId: input.chargeId, operationId: input.operationId, providerKey, status: 'INTENT_RECORDED', result: { fingerprint, externalPosId: input.externalPosId } } });
          return { chargeId: input.chargeId, providerKey, status: 'INTENT_RECORDED' };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        const e = error as { code?: string; meta?: { code?: string } } | null;
        if (attempt < 4 && (e?.code === 'P2034' || e?.code === 'P2002' || (e?.code === 'P2010' && ['40001', '40P01'].includes(e.meta?.code ?? '')))) {
          await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
          continue;
        }
        throw error;
      }
    }
  }
}
