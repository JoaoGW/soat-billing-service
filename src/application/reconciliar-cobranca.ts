import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';

type Context = { fingerprint: string; externalPosId: string; messageId: string; correlationId: string; sagaId: string; filialId: string; quoteId: string; quoteVersion: number; clientId: string; reservationId: string; traceparent?: string; tracestate?: string };
/** Uma notificação autenticada fornece apenas o ID; a order consultada é a evidência. */
export class ReconcileChargeFromWebhook {
  constructor(private readonly db: PrismaClient, private readonly provider: { get(orderId: string): Promise<Record<string, unknown>> }) {}
  async execute(eventId: string, now = new Date()): Promise<'RECOVERED' | 'PENDING'> {
    if (typeof eventId !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(eventId) || !Number.isFinite(now.getTime())) throw new Error('Notificação inválida');
    const notification = await this.db.receivedWebhook.findUnique({ where: { provider_eventId: { provider: 'mercado-pago-orders', eventId } } });
    if (!notification || notification.status !== 'RECEIVED') return 'PENDING';
    const orderId = (notification.payload as { data?: { id?: unknown } }).data?.id;
    if (typeof orderId !== 'string' || !/^ORD[a-z0-9]{26}$/i.test(orderId)) return 'PENDING';
    if (await this.db.charge.findUnique({ where: { providerOrderId: orderId }, select: { id: true } })) return 'PENDING';
    const order = await this.provider.get(orderId);
    if (order.id !== orderId || order.type !== 'qr' || typeof order.external_reference !== 'string' || !['created', 'processed'].includes(String(order.status)) || order.currency !== 'BRL') return 'PENDING';
    const charge = await this.db.charge.findUnique({ where: { externalReference: order.external_reference }, include: { quote: true, attempts: true } });
    if (!charge || charge.providerOrderId || !['IN_FLIGHT', 'RECONCILIACAO_NECESSARIA'].includes(charge.status) || charge.currency !== 'BRL') return 'PENDING';
    const amount = `${Math.floor(charge.amountInCents / 100)}.${String(charge.amountInCents % 100).padStart(2, '0')}`;
    if (order.total_amount !== amount || charge.attempts.length !== 1 || charge.amountInCents !== charge.quote.totalInCents) return 'PENDING';
    const attempt = charge.attempts[0];
    if (!['IN_FLIGHT', 'RECONCILIACAO_NECESSARIA'].includes(attempt.status) || (attempt.status === 'IN_FLIGHT' && now.getTime() - attempt.updatedAt.getTime() < 120000)) return 'PENDING';
    const context = attempt.result as Context | null;
    if (!context || [context.fingerprint, context.externalPosId, context.messageId, context.correlationId, context.sagaId, context.filialId, context.quoteId, context.clientId, context.reservationId].some(value => typeof value !== 'string' || !value) || context.quoteId !== charge.quoteId || context.quoteVersion !== charge.quote.version || context.clientId !== charge.quote.clientId || context.sagaId !== charge.quote.sagaId || context.filialId !== charge.quote.filialId || charge.osId !== charge.quote.osId) return 'PENDING';
    const typeResponse = order.type_response;
    const qr = typeResponse && typeof typeResponse === 'object' && 'qr_data' in typeResponse && typeof typeResponse.qr_data === 'string' ? typeResponse.qr_data : undefined;
    if (order.status === 'created' && !qr) return 'PENDING';
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Charge" WHERE "id"=${charge.id} FOR UPDATE`;
      const changed = await tx.chargeAttempt.updateMany({ where: { id: attempt.id, status: attempt.status, updatedAt: attempt.updatedAt }, data: { status: 'CREATED', result: { ...context, ...(qr ? { qrData: qr } : {}) } as Prisma.InputJsonObject } });
      if (!changed.count) return 'PENDING';
      const updated = await tx.charge.updateMany({ where: { id: charge.id, status: charge.status, providerOrderId: null }, data: { status: 'CREATED', providerOrderId: orderId } });
      if (!updated.count) throw new Error('Cobrança mudou durante reconciliação');
      const messageId = randomUUID(); const type = 'billing.charge-created.v1';
      await tx.outbox.create({ data: { messageId, type, payload: { messageId, type, schemaVersion: 1, occurredAt: now.toISOString(), producer: 'soat-billing-service', aggregateType: 'charge', aggregateId: charge.id, aggregateVersion: 1, osId: charge.osId, sagaId: context.sagaId, filialId: context.filialId, correlationId: context.correlationId, causationId: context.messageId, operationId: attempt.operationId, ...(context.traceparent ? { traceparent: context.traceparent } : {}), ...(context.tracestate ? { tracestate: context.tracestate } : {}), data: { quoteId: context.quoteId, quoteVersion: context.quoteVersion, chargeId: charge.id, clientId: context.clientId, totalInCents: charge.amountInCents, currency: charge.currency, providerOrderId: orderId, externalReference: charge.externalReference, expiresAt: charge.expiresAt.toISOString(), reservationId: context.reservationId } } } });
      return 'RECOVERED';
    });
  }
}
