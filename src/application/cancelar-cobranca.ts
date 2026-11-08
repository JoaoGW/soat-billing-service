import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { verifyCanonicalCancelable, verifyCanonicalCancellation } from '../domain/verificar-pagamento';

export interface CancelChargeInput {
  messageId: string; operationId: string; correlationId: string; osId: string; sagaId: string; filialId: string;
  chargeId: string; reservationId: string; cancelOperationId: string; cancelEventId: string;
  traceparent?: string; tracestate?: string;
}
type Intent = CancelChargeInput & { providerKey: string; fingerprint: string };
type Provider = { get(orderId: string): Promise<Record<string, unknown>>; cancel(orderId: string, key: string): Promise<Record<string, unknown>> };
const consumer = 'billing.cancel-charge.v1';

/** A persisted, authenticated command cannot be safely applied without review. */
export class ChargeCancellationBlockedError extends Error {
  constructor(readonly reasonCode: 'CANCEL_EVIDENCE_MISMATCH' | 'CANCEL_CHARGE_MISMATCH' | 'CANCEL_OPERATION_MISMATCH', message: string) { super(message); }
}

/** Caller authenticates and validates the OS command; Execution evidence is checked in the transaction. */
export class PrepareChargeCancellation {
  constructor(private readonly db: PrismaClient) {}
  async execute(input: CancelChargeInput): Promise<void> {
    const ids = [input.messageId, input.operationId, input.correlationId, input.osId, input.sagaId, input.filialId, input.chargeId, input.reservationId, input.cancelOperationId, input.cancelEventId];
    if (ids.some(id => typeof id !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(id))) throw new Error('Comando inválido');
    const fingerprint = createHash('sha256').update(JSON.stringify({ operationId: input.operationId, osId: input.osId, sagaId: input.sagaId, filialId: input.filialId, chargeId: input.chargeId, reservationId: input.reservationId, cancelOperationId: input.cancelOperationId, cancelEventId: input.cancelEventId })).digest('hex');
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Charge" WHERE "id" = ${input.chargeId} FOR UPDATE`;
      const previous = await tx.commandOperation.findUnique({ where: { consumer_operationId: { consumer, operationId: input.operationId } } });
      const existing = await tx.inbox.findUnique({ where: { consumer_messageId: { consumer, messageId: input.messageId } } });
      if (previous || existing) {
        const old = previous?.result as unknown as Intent | undefined;
        if (!previous || !existing || previous.payloadHash !== fingerprint || existing.operationId !== input.operationId || old?.messageId !== input.messageId) throw new ChargeCancellationBlockedError('CANCEL_OPERATION_MISMATCH', 'Operação ou mensagem divergente');
        return;
      }
      const proof = await tx.inbox.findUnique({ where: { consumer_messageId: { consumer: 'billing.compensation-evidence', messageId: input.cancelEventId } } });
      const evidence = proof?.payload as { type?: string; producer?: string; messageId?: string; operationId?: string; osId?: string; sagaId?: string; filialId?: string; data?: { outcome?: string } } | undefined;
      if (proof?.status !== 'APPLIED' || evidence?.messageId !== input.cancelEventId || evidence.type !== 'execution.work-cancelled.v1' || evidence.producer !== 'soat-execution-service' || evidence.operationId !== input.cancelOperationId || evidence.osId !== input.osId || evidence.sagaId !== input.sagaId || evidence.filialId !== input.filialId || evidence.data?.outcome !== 'CANCELLED') throw new ChargeCancellationBlockedError('CANCEL_EVIDENCE_MISMATCH', 'Evidência de cancelamento inválida');
      const charge = await tx.charge.findUnique({ where: { id: input.chargeId }, include: { quote: true, payments: true, attempts: true } });
      if (!charge || charge.osId !== input.osId || charge.quote.sagaId !== input.sagaId || charge.quote.filialId !== input.filialId || charge.status !== 'CREATED' || !charge.providerOrderId || charge.payments.length !== 0 || charge.currency !== 'BRL') throw new ChargeCancellationBlockedError('CANCEL_CHARGE_MISMATCH', 'Cobrança não permite cancelamento');
      const attempt = charge.attempts.filter(item => item.status === 'CREATED');
      const context = attempt[0]?.result as { reservationId?: string; sagaId?: string; filialId?: string } | null | undefined;
      if (attempt.length !== 1 || context?.reservationId !== input.reservationId || context.sagaId !== input.sagaId || context.filialId !== input.filialId) throw new ChargeCancellationBlockedError('CANCEL_CHARGE_MISMATCH', 'Reserva diverge da cobrança');
      const intent: Intent = { ...input, providerKey: randomUUID(), fingerprint };
      await tx.commandOperation.create({ data: { consumer, operationId: input.operationId, payloadHash: fingerprint, result: intent as unknown as Prisma.InputJsonObject } });
      await tx.inbox.create({ data: { consumer, messageId: input.messageId, operationId: input.operationId, type: consumer, payload: intent as unknown as Prisma.InputJsonObject, status: 'INTENT_RECORDED' } });
      await tx.charge.update({ where: { id: charge.id }, data: { status: 'CANCELLING' } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}

/** A durable claim permits one network attempt; ambiguous results are only queried, never resent. */
export class CancelChargeService {
  constructor(private readonly db: PrismaClient, private readonly provider: Provider) {}
  async submit(messageId: string): Promise<'CANCELED' | 'RECONCILIACAO_NECESSARIA' | 'IN_FLIGHT'> {
    const row = await this.db.inbox.findUnique({ where: { consumer_messageId: { consumer, messageId } } });
    if (!row) throw new Error('Intenção de cancelamento ausente');
    if (row.status === 'CANCELED') return 'CANCELED';
    if (row.status !== 'INTENT_RECORDED') return row.status === 'IN_FLIGHT' ? 'IN_FLIGHT' : 'RECONCILIACAO_NECESSARIA';
    const intent = row.payload as unknown as Intent;
    const charge = await this.db.charge.findUnique({ where: { id: intent.chargeId } });
    if (!charge || !charge.providerOrderId || charge.status !== 'CANCELLING') throw new Error('Estado de cancelamento inválido');
    const claimed = await this.db.inbox.updateMany({ where: { consumer, messageId, status: 'INTENT_RECORDED' }, data: { status: 'IN_FLIGHT' } });
    if (!claimed.count) return 'IN_FLIGHT';
    try {
      const expected = { orderId: charge.providerOrderId, externalReference: charge.externalReference, amountInCents: charge.amountInCents, currency: 'BRL' as const };
      if (!verifyCanonicalCancelable(await this.provider.get(charge.providerOrderId), expected)) throw new Error('Order não permite cancelamento');
      await this.provider.cancel(charge.providerOrderId, intent.providerKey);
      return await this.reconcile(messageId);
    } catch {
      await this.markUnknown(messageId, intent.chargeId);
      return 'RECONCILIACAO_NECESSARIA';
    }
  }
  async reconcile(messageId: string): Promise<'CANCELED' | 'RECONCILIACAO_NECESSARIA'> {
    const row = await this.db.inbox.findUnique({ where: { consumer_messageId: { consumer, messageId } } });
    if (!row) throw new Error('Intenção de cancelamento ausente');
    if (row.status === 'CANCELED') return 'CANCELED';
    if (!['IN_FLIGHT', 'RECONCILIACAO_NECESSARIA'].includes(row.status)) throw new Error('Cancelamento ainda não enviado');
    const intent = row.payload as unknown as Intent;
    const charge = await this.db.charge.findUnique({ where: { id: intent.chargeId }, include: { quote: true } });
    if (!charge || !charge.providerOrderId) throw new Error('Cobrança não encontrada');
    let confirmed = false;
    try { confirmed = verifyCanonicalCancellation(await this.provider.get(charge.providerOrderId), { orderId: charge.providerOrderId, externalReference: charge.externalReference, amountInCents: charge.amountInCents, currency: 'BRL' }); } catch { /* remains uncertain */ }
    if (!confirmed) { await this.markUnknown(messageId, intent.chargeId); return 'RECONCILIACAO_NECESSARIA'; }
    const outcome = await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Charge" WHERE "id" = ${charge.id} FOR UPDATE`;
      const current = await tx.charge.findUniqueOrThrow({ where: { id: charge.id }, include: { payments: true } });
      const inbox = await tx.inbox.findUniqueOrThrow({ where: { consumer_messageId: { consumer, messageId } } });
      if (inbox.status === 'CANCELED') return 'CANCELED';
      if (!['IN_FLIGHT', 'RECONCILIACAO_NECESSARIA'].includes(inbox.status) || !['CANCELLING', 'RECONCILIACAO_NECESSARIA'].includes(current.status) || current.payments.length || current.providerOrderId !== charge.providerOrderId || current.amountInCents !== charge.amountInCents || current.externalReference !== charge.externalReference) return 'RECONCILIACAO_NECESSARIA';
      const eventId = randomUUID(), type = 'billing.charge-canceled.v1';
      await tx.outbox.create({ data: { messageId: eventId, type, payload: { messageId: eventId, type, schemaVersion: 1, occurredAt: new Date().toISOString(), producer: 'soat-billing-service', aggregateType: 'charge', aggregateId: charge.id, aggregateVersion: 2, osId: intent.osId, sagaId: intent.sagaId, filialId: intent.filialId, correlationId: intent.correlationId, causationId: intent.messageId, operationId: intent.operationId, ...(intent.traceparent ? { traceparent: intent.traceparent } : {}), ...(intent.tracestate ? { tracestate: intent.tracestate } : {}), data: { chargeId: charge.id, quoteId: charge.quoteId, quoteVersion: charge.quote.version, providerOrderId: charge.providerOrderId!, reservationId: intent.reservationId, cancelOperationId: intent.cancelOperationId, cancelEventId: intent.cancelEventId } } } });
      await tx.charge.update({ where: { id: charge.id }, data: { status: 'CANCELED' } });
      await tx.inbox.update({ where: { consumer_messageId: { consumer, messageId } }, data: { status: 'CANCELED', appliedAt: new Date() } });
      return 'CANCELED' as const;
    });
    if (outcome === 'RECONCILIACAO_NECESSARIA') await this.markUnknown(messageId, intent.chargeId);
    return outcome;
  }
  private async markUnknown(messageId: string, chargeId: string): Promise<void> {
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Charge" WHERE "id" = ${chargeId} FOR UPDATE`;
      await tx.inbox.updateMany({ where: { consumer, messageId, status: 'IN_FLIGHT' }, data: { status: 'RECONCILIACAO_NECESSARIA' } });
      await tx.charge.updateMany({ where: { id: chargeId, status: 'CANCELLING' }, data: { status: 'RECONCILIACAO_NECESSARIA' } });
    });
  }
}
