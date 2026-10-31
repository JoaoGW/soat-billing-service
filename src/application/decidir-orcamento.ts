import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { decide, Decision, Quote } from '../domain/orcamento';

export interface DecideQuoteInput {
  quoteId: string;
  clientId: string; // The caller must obtain this from an authenticated JWT.
  version: number;
  decision: Decision;
  idempotencyKey: string;
  correlationId: string;
}

export interface DecideQuoteResult {
  quoteId: string;
  version: number;
  decision: Decision;
}

function isSerializationConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  if (error.code === 'P2034') return true;
  if (error.code !== 'P2010' || !('meta' in error) || typeof error.meta !== 'object' || error.meta === null || !('code' in error.meta)) return false;
  return error.meta.code === '40001' || error.meta.code === '40P01';
}

export class QuoteDecisionService {
  constructor(private readonly prisma: PrismaClient) {}

  async execute(input: DecideQuoteInput, now = new Date()): Promise<DecideQuoteResult> {
    if (!input.quoteId || !input.clientId || !input.idempotencyKey || !input.correlationId ||
      !Number.isSafeInteger(input.version) || input.version < 1 ||
      !['APPROVED', 'REJECTED'].includes(input.decision)) throw new Error('Entrada inválida');
    const route = `/orcamentos/${input.quoteId}/decisao`;
    const key = { actorId: input.clientId, route, key: input.idempotencyKey };
    const hash = createHash('sha256').update(JSON.stringify({ version: input.version, decision: input.decision })).digest('hex');
    const operationId = createHash('sha256').update(JSON.stringify([input.clientId, route, input.idempotencyKey])).digest('hex');

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          // Serialize competing decisions before reading the idempotency record.
          await tx.$queryRaw`SELECT "id" FROM "Quote" WHERE "id" = ${input.quoteId} FOR UPDATE`;
          const saved = await tx.idempotencyRequest.findUnique({ where: { actorId_route_key: key } });
          if (saved) {
            if (saved.requestHash !== hash) throw new Error('Chave de idempotência reutilizada com outra decisão');
            return saved.response as unknown as DecideQuoteResult;
          }
          const quote = await tx.quote.findUnique({ where: { id: input.quoteId } });
          if (!quote) throw new Error('Orçamento não encontrado');
          if (quote.clientId !== input.clientId) throw new Error('Acesso negado');
          const latest = await tx.quote.findFirst({ where: { osId: quote.osId }, orderBy: { version: 'desc' }, select: { id: true } });
          if (latest?.id !== quote.id) throw new Error('Versão divergente');
          if (!['ISSUED', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'].includes(quote.status)) throw new Error('Estado inválido');
          const transition = decide({ ...quote, status: quote.status as Quote['status'] }, input.clientId, input.version, input.decision, now);
          const result: DecideQuoteResult = { quoteId: quote.id, version: quote.version, decision: input.decision };
          if (transition.changed) {
            const update = await tx.quote.updateMany({
              where: { id: quote.id, revision: quote.revision, status: 'ISSUED' },
              data: { status: input.decision, revision: { increment: 1 } },
            });
            if (update.count !== 1) throw new Error('Conflito de concorrência');
            await tx.quoteDecision.create({ data: { quoteId: quote.id, actorId: input.clientId, decision: input.decision } });
            const messageId = randomUUID();
            const type = input.decision === 'APPROVED' ? 'billing.quote-approved.v1' : 'billing.quote-rejected.v1';
            await tx.outbox.create({ data: {
              messageId, type,
              payload: {
                messageId, type, schemaVersion: 1, occurredAt: now.toISOString(), producer: 'soat-billing-service',
                // revision zero denotes an issued aggregate at version one.
                aggregateType: 'quote', aggregateId: quote.id, aggregateVersion: quote.revision + 2,
                osId: quote.osId, sagaId: quote.sagaId, filialId: quote.filialId,
                correlationId: input.correlationId, causationId: operationId, operationId,
                data: { quoteId: quote.id, quoteVersion: quote.version, clientId: quote.clientId },
              },
            } });
          }
          await tx.idempotencyRequest.create({ data: { ...key, requestHash: hash, statusCode: 200, response: { ...result } } });
          return result;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (attempt < 4 && isSerializationConflict(error)) {
          await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
          continue;
        }
        throw error;
      }
    }
  }
}
