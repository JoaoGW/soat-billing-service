import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { verifyCanonicalPayment, verifyCanonicalRefund } from '../domain/verificar-pagamento';

export interface PrepareRefund {
  messageId: string; operationId: string; correlationId: string; refundId: string; paymentId: string; osId: string; sagaId: string; filialId: string;
  cancelOperationId: string; cancelEventId: string; reason: string;
}
type RefundIntent = { refundId: string; providerKey: string; messageId: string; correlationId: string; sagaId: string; filialId: string; cancelOperationId: string; cancelEventId: string; reason: string };
type Provider = { get(orderId: string): Promise<Record<string, unknown>>; refund(orderId: string, key: string): Promise<Record<string, unknown>> };

/** Caller must validate the authenticated Saga command; cancellation evidence must already be trusted and persisted. */
export class PrepareRefundService {
  constructor(private readonly db: PrismaClient) {}
  async execute(input: PrepareRefund, now = new Date()): Promise<RefundIntent> {
    const ids = [input.messageId, input.operationId, input.correlationId, input.refundId, input.paymentId, input.osId, input.sagaId, input.filialId, input.cancelOperationId, input.cancelEventId, input.reason];
    if (ids.some((id) => typeof id !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(id)) || !Number.isFinite(now.getTime())) throw new Error('Comando de reembolso inválido');
    const consumer = 'billing.refund-payment.v1';
    const fingerprint = createHash('sha256').update(JSON.stringify({ operationId: input.operationId, refundId: input.refundId, paymentId: input.paymentId, osId: input.osId, sagaId: input.sagaId, filialId: input.filialId, cancelOperationId: input.cancelOperationId, cancelEventId: input.cancelEventId, reason: input.reason })).digest('hex');
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${input.paymentId} FOR UPDATE`;
          const message = await tx.inbox.findUnique({ where: { consumer_messageId: { consumer, messageId: input.messageId } } });
          if (message && (message.operationId !== input.operationId || (message.payload as { fingerprint?: string }).fingerprint !== fingerprint)) throw new Error('Mensagem reutilizada com outro conteúdo');
          const prior = await tx.commandOperation.findUnique({ where: { consumer_operationId: { consumer, operationId: input.operationId } } });
          const recordInbox = async () => { if (!message) await tx.inbox.create({ data: { consumer, messageId: input.messageId, operationId: input.operationId, type: consumer, payload: { fingerprint }, status: 'APPLIED', appliedAt: now } }); };
          if (prior) {
            if (prior.payloadHash !== fingerprint) throw new Error('Operação reutilizada com outro conteúdo');
            await recordInbox(); return prior.result as unknown as RefundIntent;
          }
          if (message) throw new Error('Mensagem sem operação correspondente');
          const evidence = await tx.inbox.findUnique({ where: { consumer_messageId: { consumer: 'billing.compensation-evidence', messageId: input.cancelEventId } } });
          const proof = evidence?.payload as { messageId?: string; type?: string; producer?: string; operationId?: string; osId?: string; sagaId?: string; filialId?: string; data?: { outcome?: string } } | undefined;
          if (!evidence || evidence.status !== 'APPLIED' || !proof || proof.messageId !== input.cancelEventId || proof.type !== 'execution.work-cancelled.v1' || proof.producer !== 'soat-execution-service' || proof.operationId !== input.cancelOperationId || proof.osId !== input.osId || proof.sagaId !== input.sagaId || proof.filialId !== input.filialId || proof.data?.outcome !== 'CANCELLED') throw new Error('Cancelamento sem confirmação de não início');
          const payment = await tx.payment.findUnique({ where: { id: input.paymentId }, include: { charge: { include: { quote: true } } } });
          if (!payment || payment.charge.osId !== input.osId || payment.charge.quote.sagaId !== input.sagaId || payment.charge.quote.filialId !== input.filialId || payment.currency !== 'BRL' || !payment.charge.providerOrderId || !['PAID', 'RECONCILIACAO_NECESSARIA'].includes(payment.charge.status)) throw new Error('Pagamento não permite reembolso');
          if (await tx.refund.findFirst({ where: { paymentId: input.paymentId }, select: { id: true } })) throw new Error('Reembolso já existente');
          const result = { refundId: input.refundId, providerKey: randomUUID(), messageId: input.messageId, correlationId: input.correlationId, sagaId: input.sagaId, filialId: input.filialId, cancelOperationId: input.cancelOperationId, cancelEventId: input.cancelEventId, reason: input.reason };
          await tx.refund.create({ data: { id: input.refundId, paymentId: input.paymentId, operationId: input.operationId, status: 'INTENT_RECORDED', amountInCents: payment.amountInCents } });
          await tx.commandOperation.create({ data: { consumer, operationId: input.operationId, payloadHash: fingerprint, result } });
          await recordInbox(); return result;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        const e = error as { code?: string; meta?: { code?: string } } | null;
        if (attempt < 4 && (e?.code === 'P2034' || e?.code === 'P2002' || (e?.code === 'P2010' && ['40001', '40P01'].includes(e.meta?.code ?? '')))) { await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt)); continue; }
        throw error;
      }
    }
  }
}

/** One network attempt after a durable claim. Acceptance is not refund confirmation. */
export class SubmitRefundService {
  constructor(private readonly db: PrismaClient, private readonly provider: Provider) {}
  async execute(operationId: string): Promise<'PENDING_CONFIRMATION' | 'IN_FLIGHT' | 'RECONCILIACAO_NECESSARIA' | 'REFUNDED'> {
    const refund = await this.db.refund.findUnique({ where: { operationId }, include: { payment: { include: { charge: true } } } });
    if (!refund) throw new Error('Intenção de reembolso não encontrada');
    if (refund.status !== 'INTENT_RECORDED') {
      if (['PENDING_CONFIRMATION', 'IN_FLIGHT', 'RECONCILIACAO_NECESSARIA', 'REFUNDED'].includes(refund.status)) return refund.status as 'PENDING_CONFIRMATION' | 'IN_FLIGHT' | 'RECONCILIACAO_NECESSARIA' | 'REFUNDED';
      throw new Error('Estado de reembolso inválido');
    }
    const operation = await this.db.commandOperation.findUnique({ where: { consumer_operationId: { consumer: 'billing.refund-payment.v1', operationId } } });
    const intent = operation?.result as unknown as RefundIntent | undefined; const orderId = refund.payment.charge.providerOrderId;
    if (!intent || intent.refundId !== refund.id || !intent.providerKey || !orderId) throw new Error('Intenção de reembolso inválida');
    const claimed = await this.db.refund.updateMany({ where: { id: refund.id, status: 'INTENT_RECORDED' }, data: { status: 'IN_FLIGHT' } });
    if (!claimed.count) return 'IN_FLIGHT';
    let providerRefundId: string;
    try {
      const order = await this.provider.get(orderId);
      const observation = verifyCanonicalPayment(order, { orderId, externalReference: refund.payment.charge.externalReference, amountInCents: refund.amountInCents, currency: 'BRL' });
      if (observation.kind !== 'CONFIRMED' || observation.providerPaymentId !== refund.payment.providerPaymentId) throw new Error('Pagamento canônico divergente');
      const response = await this.provider.refund(orderId, intent.providerKey);
      const transactions = response.transactions;
      if (response.id !== orderId || !transactions || typeof transactions !== 'object' || !('refunds' in transactions) || !Array.isArray(transactions.refunds)) throw new Error('Resposta de reembolso inválida');
      const matches = transactions.refunds.filter((item: unknown) => item && typeof item === 'object' && 'transaction_id' in item && item.transaction_id === observation.transactionId && 'id' in item && typeof item.id === 'string' && /^REF[a-z0-9]{26}$/i.test(item.id));
      if (matches.length !== 1) throw new Error('Resposta de reembolso ambígua');
      providerRefundId = (matches[0] as { id: string }).id;
    } catch {
      await this.db.refund.updateMany({ where: { id: refund.id, status: 'IN_FLIGHT' }, data: { status: 'RECONCILIACAO_NECESSARIA' } });
      return 'RECONCILIACAO_NECESSARIA';
    }
    const updated = await this.db.refund.updateMany({ where: { id: refund.id, status: 'IN_FLIGHT' }, data: { status: 'PENDING_CONFIRMATION', providerRefundId } });
    if (!updated.count) throw new Error('Estado do reembolso mudou durante o envio');
    return 'PENDING_CONFIRMATION';
  }
}

export class ConfirmRefundService {
  constructor(private readonly db: PrismaClient, private readonly provider: Pick<Provider, 'get'>) {}
  async execute(operationId: string): Promise<'REFUNDED' | 'PENDING_CONFIRMATION' | 'RECONCILIACAO_NECESSARIA'> {
    const refund = await this.db.refund.findUnique({ where: { operationId }, include: { payment: { include: { charge: { include: { quote: true } } } } } });
    if (!refund) throw new Error('Reembolso não encontrado');
    if (refund.status === 'REFUNDED') return 'REFUNDED';
    if (refund.status === 'RECONCILIACAO_NECESSARIA' || refund.status === 'IN_FLIGHT') return 'RECONCILIACAO_NECESSARIA';
    if (refund.status !== 'PENDING_CONFIRMATION' || !refund.providerRefundId || !refund.payment.charge.providerOrderId) throw new Error('Estado de reembolso inválido');
    const operation = await this.db.commandOperation.findUnique({ where: { consumer_operationId: { consumer: 'billing.refund-payment.v1', operationId } } });
    const intent = operation?.result as unknown as RefundIntent | undefined; const charge = refund.payment.charge;
    if (!intent || intent.refundId !== refund.id || !intent.messageId || !intent.correlationId || intent.sagaId !== charge.quote.sagaId || intent.filialId !== charge.quote.filialId) throw new Error('Intenção de reembolso inválida');
    const order = await this.provider.get(charge.providerOrderId!);
    if (order.status === 'processed') return 'PENDING_CONFIRMATION';
    const valid = verifyCanonicalRefund(order, { orderId: charge.providerOrderId!, externalReference: charge.externalReference, providerPaymentId: refund.payment.providerPaymentId, providerRefundId: refund.providerRefundId, amountInCents: refund.amountInCents });
    if (!valid) {
      await this.db.refund.updateMany({ where: { id: refund.id, status: 'PENDING_CONFIRMATION' }, data: { status: 'RECONCILIACAO_NECESSARIA' } });
      return 'RECONCILIACAO_NECESSARIA';
    }
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Refund" WHERE "id" = ${refund.id} FOR UPDATE`;
      const current = await tx.refund.findUniqueOrThrow({ where: { id: refund.id } });
      if (current.status === 'REFUNDED') return 'REFUNDED';
      if (current.status !== 'PENDING_CONFIRMATION' || current.providerRefundId !== refund.providerRefundId || current.amountInCents !== refund.amountInCents) return 'RECONCILIACAO_NECESSARIA';
      const messageId = randomUUID(); const type = 'billing.payment-refunded.v1';
      await tx.outbox.create({ data: { messageId, type, payload: {
        messageId, type, schemaVersion: 1, occurredAt: new Date().toISOString(), producer: 'soat-billing-service', aggregateType: 'refund', aggregateId: refund.id, aggregateVersion: 1,
        osId: charge.osId, sagaId: intent.sagaId, filialId: intent.filialId, correlationId: intent.correlationId, causationId: intent.messageId, operationId,
        data: { refundId: refund.id, paymentId: refund.paymentId, chargeId: charge.id, quoteId: charge.quoteId, quoteVersion: charge.quote.version, amountInCents: refund.amountInCents, currency: refund.payment.currency, providerOrderId: charge.providerOrderId!, providerRefundId: refund.providerRefundId!, cancelOperationId: intent.cancelOperationId },
      } } });
      await tx.refund.update({ where: { id: refund.id }, data: { status: 'REFUNDED' } });
      await tx.charge.update({ where: { id: charge.id }, data: { status: 'REFUNDED' } });
      return 'REFUNDED';
    });
  }
}
