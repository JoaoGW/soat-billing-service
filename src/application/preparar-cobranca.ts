import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';

export interface PrepareCharge {
  messageId: string; operationId: string; correlationId: string; chargeId: string; quoteId: string; quoteVersion: number;
  osId: string; sagaId: string; filialId: string; clientId: string; totalInCents: number; currency: string;
  reservationId: string; externalPosId: string; expiresAt: string; traceparent?: string; tracestate?: string;
}

/** Persists an intent only. A separately claimed operation must call the provider. */
export class PrepareChargeService {
  constructor(private readonly db: PrismaClient) {}
  async execute(input: PrepareCharge, now = new Date()): Promise<{ chargeId: string; providerKey: string; status: string }> {
    const identifiers = [input.messageId, input.operationId, input.correlationId, input.chargeId, input.quoteId, input.osId, input.sagaId, input.filialId, input.clientId, input.reservationId, input.externalPosId];
    if (identifiers.some((id) => typeof id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(id)) ||
        !Number.isSafeInteger(input.quoteVersion) || input.quoteVersion < 1 || !Number.isSafeInteger(input.totalInCents) || input.totalInCents < 1 || input.currency !== 'BRL' || !Number.isFinite(now.getTime()) ||
        !Number.isFinite(Date.parse(input.expiresAt))) throw new Error('Dados da cobrança inválidos');
    const expiresAt = new Date(input.expiresAt);
    const fingerprint = createHash('sha256').update(JSON.stringify({ operationId: input.operationId, chargeId: input.chargeId, quoteId: input.quoteId, quoteVersion: input.quoteVersion, osId: input.osId, sagaId: input.sagaId, filialId: input.filialId, clientId: input.clientId, totalInCents: input.totalInCents, currency: input.currency, reservationId: input.reservationId, externalPosId: input.externalPosId, expiresAt: expiresAt.toISOString() })).digest('hex');
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.$transaction(async (tx) => {
          // Serialize all new charge attempts against the same quote.
          await tx.$queryRaw`SELECT "id" FROM "Quote" WHERE "id" = ${input.quoteId} FOR UPDATE`;
          const consumer = 'billing.create-charge.v1';
          const previousMessage = await tx.inbox.findUnique({ where: { consumer_messageId: { consumer, messageId: input.messageId } } });
          if (previousMessage && (previousMessage.operationId !== input.operationId || (previousMessage.payload as { fingerprint?: string }).fingerprint !== fingerprint)) throw new Error('Mensagem reutilizada com outro conteúdo');
          const recordInbox = async () => {
            if (!previousMessage) await tx.inbox.create({ data: { consumer, messageId: input.messageId, operationId: input.operationId, type: consumer, payload: { fingerprint }, status: 'APPLIED', appliedAt: now } });
          };
          const prior = await tx.chargeAttempt.findUnique({ where: { operationId: input.operationId }, include: { charge: true } });
          if (prior) {
            const result = prior.result as { fingerprint?: string } | null;
            if (result?.fingerprint !== fingerprint) throw new Error('Operação reutilizada com outro conteúdo');
            await recordInbox();
            return { chargeId: prior.chargeId, providerKey: prior.providerKey, status: prior.status };
          }
          if (previousMessage) throw new Error('Mensagem sem operação correspondente');
          const quote = await tx.quote.findUnique({ where: { id: input.quoteId } });
          if (!quote || quote.version !== input.quoteVersion || quote.osId !== input.osId || quote.sagaId !== input.sagaId || quote.filialId !== input.filialId || quote.clientId !== input.clientId || quote.totalInCents !== input.totalInCents || quote.status !== 'APPROVED' || quote.currency !== 'BRL' || quote.totalInCents <= 0) throw new Error('Orçamento não permite cobrança');
          if (await tx.charge.findFirst({ where: { quoteId: input.quoteId }, select: { id: true } })) throw new Error('Cobrança já existente para o orçamento');
          const providerKey = randomUUID();
          await tx.charge.create({ data: { id: input.chargeId, quoteId: quote.id, osId: quote.osId, status: 'INTENT_RECORDED', amountInCents: quote.totalInCents, currency: quote.currency, externalReference: input.chargeId, expiresAt } });
          await tx.chargeAttempt.create({ data: { id: randomUUID(), chargeId: input.chargeId, operationId: input.operationId, providerKey, status: 'INTENT_RECORDED', result: { fingerprint, externalPosId: input.externalPosId, messageId: input.messageId, correlationId: input.correlationId, sagaId: input.sagaId, filialId: input.filialId, quoteId: input.quoteId, quoteVersion: input.quoteVersion, clientId: input.clientId, reservationId: input.reservationId, ...(input.traceparent ? { traceparent: input.traceparent } : {}), ...(input.tracestate ? { tracestate: input.tracestate } : {}) } } });
          await recordInbox();
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
