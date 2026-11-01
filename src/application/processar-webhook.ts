import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { verifyCanonicalPayment, verifyProviderPayment } from '../domain/verificar-pagamento';

type Provider = { get(orderId: string): Promise<Record<string, unknown>>; getPayment(paymentId: string): Promise<Record<string, unknown>> };
type Context = { messageId: string; correlationId: string; sagaId: string; filialId: string; quoteId: string; quoteVersion: number; clientId: string; reservationId: string; traceparent?: string; tracestate?: string };
type Result = 'APPLIED' | 'PENDING' | 'RECONCILIACAO_NECESSARIA';

/** Reads canonical provider state; webhook body is only a notification, never proof of payment. */
export class ProcessMercadoPagoWebhook {
  constructor(private readonly db: PrismaClient, private readonly provider: Provider) {}

  async execute(eventId: string): Promise<Result> {
    const where = { provider_eventId: { provider: 'mercado-pago-orders', eventId } };
    const notification = await this.db.receivedWebhook.findUnique({ where });
    if (!notification) throw new Error('Notificação não encontrada');
    if (notification.status === 'APPLIED') return 'APPLIED';
    if (notification.status === 'RECONCILIACAO_NECESSARIA') return 'RECONCILIACAO_NECESSARIA';
    if (notification.status !== 'RECEIVED') throw new Error('Estado de notificação inválido');
    const payload = notification.payload as { data?: { id?: unknown } };
    const orderId = payload.data?.id;
    if (typeof orderId !== 'string' || !/^ORD[a-z0-9]{26}$/i.test(orderId)) return this.markReconciliation(where);
    const charge = await this.db.charge.findUnique({ where: { providerOrderId: orderId }, include: { quote: true, attempts: true } });
    // A notification can arrive before ChargeCreated is committed locally.
    if (!charge) return 'PENDING';
    const order = await this.provider.get(orderId);
    const observed = verifyCanonicalPayment(order, { orderId, externalReference: charge.externalReference, amountInCents: charge.amountInCents, currency: 'BRL' });
    if (observed.kind === 'PENDING') return 'PENDING';
    if (observed.kind !== 'CONFIRMED') return this.markReconciliation(where);
    const details = await this.provider.getPayment(observed.providerPaymentId);
    const payment = verifyProviderPayment(details, observed.providerPaymentId, charge.amountInCents);
    if (!payment) return this.markReconciliation(where);
    const attempt = charge.attempts.find((item) => item.status === 'CREATED');
    const context = attempt?.result as Context | null | undefined;
    if (!attempt || !context || [context.messageId, context.correlationId, context.sagaId, context.filialId, context.quoteId, context.clientId].some((value) => typeof value !== 'string' || !value) ||
        context.quoteId !== charge.quoteId || context.quoteVersion !== charge.quote.version || context.clientId !== charge.quote.clientId ||
        context.sagaId !== charge.quote.sagaId || context.filialId !== charge.quote.filialId) return this.markReconciliation(where);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Charge" WHERE "id" = ${charge.id} FOR UPDATE`;
      const current = await tx.charge.findUniqueOrThrow({ where: { id: charge.id } });
      const currentNotification = await tx.receivedWebhook.findUniqueOrThrow({ where });
      if (currentNotification.status === 'APPLIED') return 'APPLIED';
      if (currentNotification.status !== 'RECEIVED') return 'RECONCILIACAO_NECESSARIA';
      if (current.providerOrderId !== orderId || current.amountInCents !== charge.amountInCents || current.currency !== 'BRL' || current.quoteId !== charge.quoteId) {
        await tx.receivedWebhook.update({ where, data: { status: 'RECONCILIACAO_NECESSARIA' } });
        return 'RECONCILIACAO_NECESSARIA';
      }
      const existing = await tx.payment.findUnique({ where: { providerPaymentId: observed.providerPaymentId } });
      if (existing && (existing.chargeId !== current.id || existing.amountInCents !== current.amountInCents || existing.currency !== current.currency)) {
        await tx.receivedWebhook.update({ where, data: { status: 'RECONCILIACAO_NECESSARIA' } });
        return 'RECONCILIACAO_NECESSARIA';
      }
      if (current.status === 'PAID' && existing) {
        await tx.receivedWebhook.update({ where, data: { status: 'APPLIED' } });
        return 'APPLIED';
      }
      if (current.status !== 'CREATED') {
        // Persist the late financial fact, but never release work automatically.
        if (!existing) await tx.payment.create({ data: { id: randomUUID(), chargeId: current.id, providerPaymentId: observed.providerPaymentId, amountInCents: current.amountInCents, currency: current.currency, paidAt: payment.paidAt } });
        await tx.charge.update({ where: { id: current.id }, data: { status: 'RECONCILIACAO_NECESSARIA' } });
        await tx.receivedWebhook.update({ where, data: { status: 'RECONCILIACAO_NECESSARIA' } });
        return 'RECONCILIACAO_NECESSARIA';
      }
      const paymentId = existing?.id ?? randomUUID();
      if (!existing) await tx.payment.create({ data: { id: paymentId, chargeId: current.id, providerPaymentId: observed.providerPaymentId, amountInCents: current.amountInCents, currency: current.currency, paidAt: payment.paidAt } });
      const messageId = randomUUID(); const type = 'billing.payment-confirmed.v1';
      await tx.outbox.create({ data: { messageId, type, payload: {
        messageId, type, schemaVersion: 1, occurredAt: new Date().toISOString(), producer: 'soat-billing-service', aggregateType: 'charge', aggregateId: current.id, aggregateVersion: 2,
        osId: current.osId, sagaId: context.sagaId, filialId: context.filialId, correlationId: context.correlationId, causationId: eventId, operationId: attempt.operationId,
        ...(context.traceparent ? { traceparent: context.traceparent } : {}), ...(context.tracestate ? { tracestate: context.tracestate } : {}),
        data: { chargeId: current.id, quoteId: current.quoteId, quoteVersion: context.quoteVersion, paymentId, providerOrderId: orderId, providerPaymentId: observed.providerPaymentId, amountInCents: current.amountInCents, currency: current.currency, paidAt: payment.paidAt.toISOString() },
      } } });
      await tx.charge.update({ where: { id: current.id }, data: { status: 'PAID' } });
      await tx.receivedWebhook.update({ where, data: { status: 'APPLIED' } });
      return 'APPLIED';
    });
  }

  private async markReconciliation(where: { provider_eventId: { provider: string; eventId: string } }): Promise<Result> {
    await this.db.receivedWebhook.updateMany({ where: { provider: where.provider_eventId.provider, eventId: where.provider_eventId.eventId, status: 'RECEIVED' }, data: { status: 'RECONCILIACAO_NECESSARIA' } });
    return 'RECONCILIACAO_NECESSARIA';
  }
}
