import { PrismaClient } from '@prisma/client';
import { verifyCanonicalRefund } from '../domain/verificar-pagamento';
import { ConfirmRefundService } from './reembolsar-pagamento';

/** Consulta somente leitura: nunca repete o pedido de reembolso ao provedor. */
export class ReconcileRefundService {
  constructor(private readonly db: PrismaClient, private readonly provider: { get(orderId: string): Promise<Record<string, unknown>> }) {}

  async execute(operationId: string, now = new Date()): Promise<'REFUNDED' | 'PENDING' | 'RECONCILIACAO_NECESSARIA'> {
    if (!/^[a-z0-9_-]{1,128}$/i.test(operationId) || !Number.isFinite(now.getTime())) throw new Error('Operação inválida');
    const refund = await this.db.refund.findUnique({ where: { operationId }, include: { payment: { include: { charge: true } } } });
    if (!refund) throw new Error('Reembolso não encontrado');
    if (refund.status === 'REFUNDED') return 'REFUNDED';
    if (refund.status === 'PENDING_CONFIRMATION') return new ConfirmRefundService(this.db, this.provider).execute(operationId).then(result => result === 'PENDING_CONFIRMATION' ? 'PENDING' : result);
    if (!['IN_FLIGHT', 'RECONCILIACAO_NECESSARIA'].includes(refund.status)) return 'PENDING';
    // Aguarda o envio original terminar antes de comparar e trocar o estado.
    if (refund.status === 'IN_FLIGHT' && now.getTime() - refund.updatedAt.getTime() < 120000) return 'PENDING';
    const charge = refund.payment.charge;
    if (!charge.providerOrderId) return 'RECONCILIACAO_NECESSARIA';
    const order = await this.provider.get(charge.providerOrderId);
    const transactions = order.transactions;
    if (!transactions || typeof transactions !== 'object' || !('refunds' in transactions) || !Array.isArray(transactions.refunds)) return 'RECONCILIACAO_NECESSARIA';
    const ids = transactions.refunds.flatMap((item: unknown) => item && typeof item === 'object' && 'id' in item && typeof item.id === 'string' && /^REF[a-z0-9]{26}$/i.test(item.id) ? [item.id] : []);
    const matches = [...new Set(ids)].filter(providerRefundId => verifyCanonicalRefund(order, { orderId: charge.providerOrderId!, externalReference: charge.externalReference, providerPaymentId: refund.payment.providerPaymentId, providerRefundId, amountInCents: refund.amountInCents }));
    if (matches.length !== 1 || (refund.providerRefundId && refund.providerRefundId !== matches[0])) return 'RECONCILIACAO_NECESSARIA';
    const changed = await this.db.refund.updateMany({ where: { id: refund.id, status: refund.status, updatedAt: refund.updatedAt, providerRefundId: refund.providerRefundId }, data: { status: 'PENDING_CONFIRMATION', providerRefundId: matches[0] } });
    if (!changed.count) return 'PENDING';
    const result = await new ConfirmRefundService(this.db, this.provider).execute(operationId);
    return result === 'PENDING_CONFIRMATION' ? 'PENDING' : result;
  }
}
