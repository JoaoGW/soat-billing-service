import { verifyCanonicalPayment, verifyProviderPayment, verifyCanonicalRefund, verifyCanonicalCancellation, verifyCanonicalCancelable } from './verificar-pagamento';

describe('cancelamento financeiro canônico', () => {
  const expected = { orderId: 'order', externalReference: 'ref', amountInCents: 5001, currency: 'BRL' as const };
  const payment = { id: 'pay', status: 'canceled', status_detail: 'canceled_by_api', paid_amount: '0.00' };
  const order = { id: 'order', type: 'qr', external_reference: 'ref', currency: 'BRL', total_amount: '50.01', status: 'canceled', status_detail: 'canceled', transactions: { payments: [payment] } };
  it('confirma apenas order e transação canceladas sem valor pago', () => {
    expect(verifyCanonicalCancellation(order, expected)).toBe(true);
    const withoutPaidAmount = { id: 'pay', status: 'canceled', status_detail: 'canceled_by_api' };
    expect(verifyCanonicalCancellation({ ...order, transactions: { payments: [withoutPaidAmount] } }, expected)).toBe(true);
  });
  it('recusa identidade, valores, estado ou transações divergentes', () => {
    for (const bad of [null, { ...order, id: 'other' }, { ...order, external_reference: 'other' }, { ...order, currency: 'USD' }, { ...order, total_amount: '50.02' }, { ...order, status: 'processed' }, { ...order, status_detail: 'unknown' }, { ...order, transactions: {} }, { ...order, transactions: { payments: [] } }, { ...order, transactions: { payments: [payment, payment] } }, { ...order, transactions: { payments: [{ ...payment, status: 'processed' }] } }, { ...order, transactions: { payments: [{ ...payment, paid_amount: '0.01' }] } }, { ...order, transactions: { payments: [payment], refunds: [{}] } }]) expect(verifyCanonicalCancellation(bad, expected)).toBe(false);
    expect(verifyCanonicalCancellation(order, { ...expected, amountInCents: 0 })).toBe(false);
  });
  it('permite tentativa apenas enquanto a order e a transação estão abertas e sem pagamento', () => {
    const open = { ...order, status: 'created', status_detail: 'created', transactions: { payments: [{ ...payment, status: 'created', status_detail: 'created' }] } };
    expect(verifyCanonicalCancelable(open, expected)).toBe(true);
    expect(verifyCanonicalCancelable(order, expected)).toBe(false);
    expect(verifyCanonicalCancelable({ ...open, transactions: { payments: [{ ...open.transactions.payments[0], paid_amount: '0.01' }] } }, expected)).toBe(false);
    expect(verifyCanonicalCancelable({ ...open, external_reference: 'other' }, expected)).toBe(false);
  });
});

describe('observação canônica de pagamento', () => {
  const expected = { orderId: 'order', externalReference: 'os-1', amountInCents: 5001, currency: 'BRL' as const };
  const payment = { id: 'pay-1', reference_id: 'provider-1', status: 'processed', status_detail: 'accredited', paid_amount: '50.01' };
  const order = { id: 'order', type: 'qr', external_reference: 'os-1', currency: 'BRL', total_amount: '50.01', status: 'processed', status_detail: 'accredited', transactions: { payments: [payment] } };
  it('confirma somente order e transação canônicas pagas integralmente', () => {
    expect(verifyCanonicalPayment(order, expected)).toEqual({ kind: 'CONFIRMED', transactionId: 'pay-1', providerPaymentId: 'provider-1' });
    expect(verifyCanonicalPayment({ ...order, status: 'created' }, expected)).toEqual({ kind: 'PENDING' });
  });
  it('exige reconciliação por divergência de referência, moeda, valor ou status', () => {
    for (const bad of [{ ...order, external_reference: 'other' }, { ...order, currency: 'USD' }, { ...order, total_amount: '50.02' }, { ...order, total_amount: '50.001' }, { ...order, status: 'refunded' }, { ...order, status_detail: 'pending' }]) {
      expect(verifyCanonicalPayment(bad, expected)).toEqual({ kind: 'RECONCILE' });
    }
  });
  it('rejeita transação incompleta, múltipla ou parcialmente paga', () => {
    for (const payments of [[], [payment, payment], [{ ...payment, paid_amount: '1.00' }], [{ ...payment, reference_id: '' }], [{ ...payment, status: 'created' }]]) {
      expect(verifyCanonicalPayment({ ...order, transactions: { payments } }, expected)).toEqual({ kind: 'RECONCILE' });
    }
    expect(verifyCanonicalPayment(null, expected)).toEqual({ kind: 'RECONCILE' });
  });
});

describe('dados canônicos do pagamento', () => {
  const payment = { id: 12345, status: 'approved', status_detail: 'accredited', currency_id: 'BRL', transaction_amount: 50.01, transaction_amount_refunded: 0, date_approved: '2030-01-01T12:00:00Z' };
  it('valida detalhes e usa a data real de aprovação', () => {
    expect(verifyProviderPayment(payment, '12345', 5001)?.paidAt.toISOString()).toBe('2030-01-01T12:00:00.000Z');
  });
  it('não aceita id, valor, moeda ou data divergentes', () => {
    for (const bad of [{ ...payment, id: 123 }, { ...payment, status: 'pending' }, { ...payment, currency_id: 'USD' }, { ...payment, transaction_amount: 50.02 }, { ...payment, date_approved: '2030-01-01' }]) expect(verifyProviderPayment(bad, '12345', 5001)).toBeNull();
  });
});

describe('reembolso canônico', () => {
  const expected = { orderId: 'order', externalReference: 'ref', providerPaymentId: '123', providerRefundId: 'refund', amountInCents: 5001 };
  const order = { id: 'order', type: 'qr', external_reference: 'ref', currency: 'BRL', total_amount: '50.01', status: 'refunded', transactions: { payments: [{ id: 'pay', reference_id: '123', status: 'refunded', refunded_amount: '50.01' }], refunds: [{ id: 'refund', transaction_id: 'pay', status: 'processed', amount: '50.01' }] } };
  it('exige order e transação reembolsadas integralmente', () => { expect(verifyCanonicalRefund(order, expected)).toBe(true); });
  it('rejeita valores, status ou transações divergentes', () => {
    expect(verifyCanonicalRefund({ ...order, status: 'processed' }, expected)).toBe(false);
    expect(verifyCanonicalRefund({ ...order, transactions: { ...order.transactions, refunds: [{ ...order.transactions.refunds[0], amount: '1.00' }] } }, expected)).toBe(false);
    expect(verifyCanonicalRefund({ ...order, transactions: { ...order.transactions, payments: [{ ...order.transactions.payments[0], reference_id: 'other' }] } }, expected)).toBe(false);
  });
});
