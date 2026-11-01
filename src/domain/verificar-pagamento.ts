export interface ExpectedPayment {
  orderId: string;
  externalReference: string;
  amountInCents: number;
  currency: 'BRL';
}

export type PaymentObservation =
  | { kind: 'CONFIRMED'; transactionId: string; providerPaymentId: string }
  | { kind: 'PENDING' }
  | { kind: 'RECONCILE' };

function cents(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fractional = ''] = value.split('.');
  const amount = BigInt(whole) * 100n + BigInt(fractional.padEnd(2, '0'));
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}

/** Input must come from an authenticated provider query, not a webhook body. */
export function verifyCanonicalPayment(order: unknown, expected: ExpectedPayment): PaymentObservation {
  if (!order || typeof order !== 'object' || Array.isArray(order) || !Number.isSafeInteger(expected.amountInCents) || expected.amountInCents <= 0) return { kind: 'RECONCILE' };
  const value = order as Record<string, unknown>;
  if (value.id !== expected.orderId || value.type !== 'qr' || value.external_reference !== expected.externalReference ||
      value.currency !== expected.currency || cents(value.total_amount) !== expected.amountInCents) return { kind: 'RECONCILE' };
  if (value.status === 'created' || value.status === 'processing') return { kind: 'PENDING' };
  if (value.status !== 'processed' || value.status_detail !== 'accredited') return { kind: 'RECONCILE' };
  const transactions = value.transactions;
  if (!transactions || typeof transactions !== 'object' || !('payments' in transactions) || !Array.isArray(transactions.payments) || transactions.payments.length !== 1) return { kind: 'RECONCILE' };
  const payment: unknown = transactions.payments[0];
  if (!payment || typeof payment !== 'object' || !('id' in payment) || typeof payment.id !== 'string' || !payment.id ||
      !('reference_id' in payment) || typeof payment.reference_id !== 'string' || !payment.reference_id ||
      !('status' in payment) || payment.status !== 'processed' || !('status_detail' in payment) || payment.status_detail !== 'accredited' ||
      !('paid_amount' in payment) || cents(payment.paid_amount) !== expected.amountInCents) return { kind: 'RECONCILE' };
  return { kind: 'CONFIRMED', transactionId: payment.id, providerPaymentId: payment.reference_id };
}
