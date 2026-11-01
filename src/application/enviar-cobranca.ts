import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { CreateQrOrder } from '../infrastructure/mercado-pago/orders-client';

type Provider = { create(input: CreateQrOrder): Promise<Record<string, unknown>> };
type IntentResult = { fingerprint: string; externalPosId: string; messageId: string; correlationId: string; sagaId: string; filialId: string; quoteId: string; quoteVersion: number; clientId: string; reservationId: string; traceparent?: string; tracestate?: string };
type Outcome = 'CREATED' | 'IN_FLIGHT' | 'RECONCILIACAO_NECESSARIA' | 'EXPIRED';

/** A committed claim precedes the network call. IN_FLIGHT is never automatically resent. */
export class SubmitChargeService {
  constructor(private readonly db: PrismaClient, private readonly provider: Provider) {}

  async execute(operationId: string, now = new Date()): Promise<Outcome> {
    if (!/^[a-z0-9_-]{1,64}$/i.test(operationId) || !Number.isFinite(now.getTime())) throw new Error('Operação inválida');
    const attempt = await this.db.chargeAttempt.findUnique({ where: { operationId }, include: { charge: true } });
    if (!attempt) throw new Error('Intenção não encontrada');
    if (attempt.status !== 'INTENT_RECORDED') return this.existing(attempt.status);
    const intent = attempt.result as IntentResult | null;
    if (!intent || [intent.fingerprint, intent.externalPosId, intent.messageId, intent.correlationId, intent.sagaId, intent.filialId, intent.quoteId, intent.clientId, intent.reservationId].some((value) => typeof value !== 'string' || !value) || !Number.isSafeInteger(intent.quoteVersion)) throw new Error('Intenção inválida');
    const remainingMinutes = Math.floor((attempt.charge.expiresAt.getTime() - now.getTime()) / 60000);
    const claimStatus = remainingMinutes < 1 ? 'EXPIRED' : 'IN_FLIGHT';
    const claimed = await this.db.$transaction(async (tx) => {
      const charge = await tx.charge.updateMany({ where: { id: attempt.chargeId, status: 'INTENT_RECORDED' }, data: { status: claimStatus } });
      if (!charge.count) return false;
      const updated = await tx.chargeAttempt.updateMany({ where: { id: attempt.id, status: 'INTENT_RECORDED' }, data: { status: claimStatus } });
      if (!updated.count) throw new Error('Estado da intenção inconsistente');
      if (claimStatus === 'EXPIRED') {
        const messageId = randomUUID(); const type = 'billing.charge-failed.v1';
        await tx.outbox.create({ data: { messageId, type, payload: {
          messageId, type, schemaVersion: 1, occurredAt: now.toISOString(), producer: 'soat-billing-service',
          aggregateType: 'charge', aggregateId: attempt.chargeId, aggregateVersion: 1,
          osId: attempt.charge.osId, sagaId: intent.sagaId, filialId: intent.filialId,
          correlationId: intent.correlationId, causationId: intent.messageId, operationId,
          ...(intent.traceparent ? { traceparent: intent.traceparent } : {}), ...(intent.tracestate ? { tracestate: intent.tracestate } : {}),
          data: { quoteId: intent.quoteId, quoteVersion: intent.quoteVersion, chargeId: attempt.chargeId, reservationId: intent.reservationId, reasonCode: 'EXPIRED' },
        } } });
      }
      return true;
    });
    if (!claimed) return 'IN_FLIGHT';
    if (claimStatus === 'EXPIRED') return 'EXPIRED';
    let response: Record<string, unknown>;
    try {
      response = await this.provider.create({ amountInCents: attempt.charge.amountInCents, externalReference: attempt.charge.externalReference, externalPosId: intent.externalPosId, idempotencyKey: attempt.providerKey, expirationMinutes: Math.min(remainingMinutes, 1440) });
      const total = `${Math.floor(attempt.charge.amountInCents / 100)}.${String(attempt.charge.amountInCents % 100).padStart(2, '0')}`;
      const qr = response.type_response;
      if (typeof response.id !== 'string' || !/^ORD[a-z0-9]{26}$/i.test(response.id) || response.type !== 'qr' || response.external_reference !== attempt.charge.externalReference || response.currency !== 'BRL' || response.total_amount !== total || response.status !== 'created' || !qr || typeof qr !== 'object' || !('qr_data' in qr) || typeof qr.qr_data !== 'string' || !qr.qr_data) throw new Error('Resposta inconsistente');
    } catch {
      await this.db.$transaction(async (tx) => {
        const updated = await tx.chargeAttempt.updateMany({ where: { id: attempt.id, status: 'IN_FLIGHT' }, data: { status: 'RECONCILIACAO_NECESSARIA' } });
        if (updated.count) await tx.charge.update({ where: { id: attempt.chargeId }, data: { status: 'RECONCILIACAO_NECESSARIA' } });
      });
      return 'RECONCILIACAO_NECESSARIA';
    }
    const qr = response.type_response as { qr_data: string };
    await this.db.$transaction(async (tx) => {
      const updated = await tx.chargeAttempt.updateMany({ where: { id: attempt.id, status: 'IN_FLIGHT' }, data: { status: 'CREATED', result: { ...intent, qrData: qr.qr_data } } });
      if (!updated.count) throw new Error('Operação de cobrança mudou durante o envio');
      await tx.charge.update({ where: { id: attempt.chargeId }, data: { status: 'CREATED', providerOrderId: response.id as string } });
      const messageId = randomUUID();
      const type = 'billing.charge-created.v1';
      await tx.outbox.create({ data: { messageId, type, payload: {
        messageId, type, schemaVersion: 1, occurredAt: now.toISOString(), producer: 'soat-billing-service',
        aggregateType: 'charge', aggregateId: attempt.chargeId, aggregateVersion: 1,
        osId: attempt.charge.osId, sagaId: intent.sagaId, filialId: intent.filialId,
        correlationId: intent.correlationId, causationId: intent.messageId, operationId,
        ...(intent.traceparent ? { traceparent: intent.traceparent } : {}), ...(intent.tracestate ? { tracestate: intent.tracestate } : {}),
        data: { quoteId: intent.quoteId, quoteVersion: intent.quoteVersion, chargeId: attempt.chargeId,
          clientId: intent.clientId, totalInCents: attempt.charge.amountInCents, currency: attempt.charge.currency,
          providerOrderId: response.id as string, externalReference: attempt.charge.externalReference,
          expiresAt: attempt.charge.expiresAt.toISOString(), reservationId: intent.reservationId },
      } } });
    });
    return 'CREATED';
  }

  private existing(status: string): Outcome {
    if (status === 'CREATED' || status === 'EXPIRED' || status === 'IN_FLIGHT' || status === 'RECONCILIACAO_NECESSARIA') return status;
    throw new Error('Estado de cobrança desconhecido');
  }
}
