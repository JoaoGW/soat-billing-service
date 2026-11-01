import { verifyCanonicalPayment, verifyProviderPayment } from './verificar-pagamento';

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
