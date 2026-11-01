import { MercadoPagoError, MercadoPagoOrdersClient } from './orders-client';

describe('MercadoPagoOrdersClient', () => {
  const id = `ORD${'A'.repeat(26)}`;
  const http = jest.fn<Promise<Response>, [string, RequestInit]>();
  const client = new MercadoPagoOrdersClient('token', http, 1000);
  const input = { amountInCents: 5001, externalReference: 'os_1', externalPosId: 'pos_1', idempotencyKey: 'op_1', expirationMinutes: 15 };
  beforeEach(() => { jest.resetAllMocks(); http.mockImplementation(async () => new Response(JSON.stringify({ id, status: 'created' }), { status: 201 })); });
  it('envia order QR em centavos precisos e chave estável', async () => {
    await expect(client.create(input)).resolves.toMatchObject({ id });
    const [url, options] = http.mock.calls[0];
    expect(url).toBe('https://api.mercadopago.com/v1/orders');
    expect(options.headers).toMatchObject({ Authorization: 'Bearer token', 'X-Idempotency-Key': 'op_1' });
    expect(JSON.parse(String(options.body))).toMatchObject({ total_amount: '50.01', external_reference: 'os_1', expiration_time: 'PT15M', config: { qr: { mode: 'dynamic', external_pos_id: 'pos_1' } }, transactions: { payments: [{ amount: '50.01' }] } });
  });
  it('consulta, cancela e solicita reembolso com paths e chaves separados', async () => {
    await client.get(id); await client.cancel(id, 'cancel'); await client.refund(id, 'refund');
    expect(http.mock.calls.map(([url]) => url)).toEqual([`https://api.mercadopago.com/v1/orders/${id}`, `https://api.mercadopago.com/v1/orders/${id}/cancel`, `https://api.mercadopago.com/v1/orders/${id}/refund`]);
    expect(http.mock.calls[1][1].headers).toMatchObject({ 'X-Idempotency-Key': 'cancel' });
    expect(http.mock.calls[2][1].headers).toMatchObject({ 'X-Idempotency-Key': 'refund' });
  });
  it('consulta pagamento pelo identificador canônico e rejeita IDs divergentes', async () => {
    http.mockResolvedValueOnce(new Response(JSON.stringify({ id: 12345, status: 'approved' }), { status: 200 }));
    await expect(client.getPayment('12345')).resolves.toMatchObject({ status: 'approved' });
    expect(http.mock.calls[0][0]).toBe('https://api.mercadopago.com/v1/payments/12345');
    http.mockResolvedValueOnce(new Response(JSON.stringify({ id: 999 }), { status: 200 }));
    await expect(client.getPayment('12345')).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    await expect(client.getPayment('../123')).rejects.toThrow('inválido');
  });
  it('não chama o provedor com dados inválidos', async () => {
    await expect(client.create({ ...input, amountInCents: 0 })).rejects.toThrow('inválidos');
    await expect(client.create({ ...input, externalReference: '../' })).rejects.toThrow('inválidos');
    await expect(client.create({ ...input, idempotencyKey: 'a\nb' })).rejects.toThrow('idempotência');
    await expect(client.get('../x')).rejects.toThrow('order');
    expect(() => new MercadoPagoOrdersClient('bad\nsecret')).toThrow('Configuração');
    expect(http).not.toHaveBeenCalled();
  });
  it('marca como incerta qualquer falha de rede ou conflito em mutação', async () => {
    http.mockRejectedValueOnce(new Error('timeout'));
    await expect(client.create(input)).rejects.toMatchObject({ kind: 'RECONCILE' });
    http.mockResolvedValueOnce(new Response('{}', { status: 409 }));
    await expect(client.cancel(id, 'cancel')).rejects.toMatchObject({ kind: 'RECONCILE', status: 409 });
    http.mockResolvedValueOnce(new Response('{}', { status: 400 }));
    await expect(client.create(input)).rejects.toMatchObject({ kind: 'REJECTED', status: 400 });
    expect(http).toHaveBeenCalledTimes(3);
  });
  it('recusa resposta incompleta ou de order diferente', async () => {
    http.mockResolvedValueOnce(new Response('not-json', { status: 201 }));
    await expect(client.create(input)).rejects.toBeInstanceOf(MercadoPagoError);
    http.mockResolvedValueOnce(new Response(JSON.stringify({ id: `ORD${'B'.repeat(26)}`, status: 'created' }), { status: 200 }));
    await expect(client.get(id)).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    http.mockResolvedValueOnce(new Response('{}', { status: 201 }));
    await expect(client.refund(id, 'refund')).rejects.toMatchObject({ kind: 'RECONCILE' });
  });
});
