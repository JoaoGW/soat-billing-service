/** A provider response is evidence to reconcile, not confirmation of payment. */
export class MercadoPagoError extends Error {
  constructor(readonly kind: 'RECONCILE' | 'REJECTED' | 'UNAVAILABLE', readonly status?: number) {
    super(`Mercado Pago: ${kind}`);
  }
}

export interface CreateQrOrder {
  amountInCents: number;
  externalReference: string;
  externalPosId: string;
  idempotencyKey: string;
  expirationMinutes: number;
}

type HttpFetch = (input: string, init: RequestInit) => Promise<Response>;

/** No retries: mutation uncertainty must be resolved using durable intent and reconciliation. */
export class MercadoPagoOrdersClient {
  private readonly endpoint = 'https://api.mercadopago.com/v1/orders';
  constructor(private readonly token: string, private readonly http: HttpFetch = fetch, private readonly timeoutMs = 10000) {
    if (!token || /[\r\n]/.test(token) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Configuração Mercado Pago inválida');
  }

  async create(input: CreateQrOrder): Promise<Record<string, unknown>> {
    if (!Number.isSafeInteger(input.amountInCents) || input.amountInCents <= 0 ||
        !/^[a-z0-9_-]{1,64}$/i.test(input.externalReference) || !/^[a-z0-9_-]{1,64}$/i.test(input.externalPosId) ||
        !Number.isSafeInteger(input.expirationMinutes) || input.expirationMinutes < 1 || input.expirationMinutes > 1440) throw new Error('Dados da cobrança inválidos');
    this.validateKey(input.idempotencyKey);
    const amount = `${Math.floor(input.amountInCents / 100)}.${String(input.amountInCents % 100).padStart(2, '0')}`;
    return this.request('POST', '', input.idempotencyKey, {
      type: 'qr', total_amount: amount, external_reference: input.externalReference,
      expiration_time: `PT${input.expirationMinutes}M`, config: { qr: { external_pos_id: input.externalPosId, mode: 'dynamic' } },
      transactions: { payments: [{ amount }] },
    });
  }

  async get(orderId: string): Promise<Record<string, unknown>> {
    return this.request('GET', this.validateOrderId(orderId));
  }

  async getPayment(paymentId: string): Promise<Record<string, unknown>> {
    if (typeof paymentId !== 'string' || !/^[0-9]{1,20}$/.test(paymentId)) throw new Error('ID de pagamento inválido');
    let response: Response;
    try {
      response = await this.http(`https://api.mercadopago.com/v1/payments/${paymentId}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' } });
    } catch { throw new MercadoPagoError('UNAVAILABLE'); }
    if (!response.ok) throw new MercadoPagoError(response.status >= 500 || response.status === 429 ? 'UNAVAILABLE' : 'REJECTED', response.status);
    let data: unknown;
    try { data = await response.json(); } catch { throw new MercadoPagoError('UNAVAILABLE'); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('id' in data) ||
        !((typeof data.id === 'string' && data.id === paymentId) || (typeof data.id === 'number' && Number.isSafeInteger(data.id) && String(data.id) === paymentId))) throw new MercadoPagoError('UNAVAILABLE');
    return data as Record<string, unknown>;
  }

  async cancel(orderId: string, key: string): Promise<Record<string, unknown>> {
    this.validateKey(key);
    return this.request('POST', `${this.validateOrderId(orderId)}/cancel`, key);
  }

  async refund(orderId: string, key: string): Promise<Record<string, unknown>> {
    this.validateKey(key);
    return this.request('POST', `${this.validateOrderId(orderId)}/refund`, key);
  }

  private validateKey(key: string): void {
    if (typeof key !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(key)) throw new Error('Chave de idempotência inválida');
  }

  private validateOrderId(orderId: string): string {
    if (typeof orderId !== 'string' || !/^ORD[a-z0-9]{26}$/i.test(orderId)) throw new Error('ID de order inválido');
    return `/${orderId}`;
  }

  private async request(method: 'GET' | 'POST', path: string, key?: string, body?: object): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.http(`${this.endpoint}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json', ...(key ? { 'X-Idempotency-Key': key } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new MercadoPagoError(method === 'POST' ? 'RECONCILE' : 'UNAVAILABLE');
    }
    if (!response.ok) {
      const uncertain = response.status >= 500 || [408, 409, 425, 429].includes(response.status);
      throw new MercadoPagoError(method === 'POST' && uncertain ? 'RECONCILE' : response.status >= 500 || response.status === 429 ? 'UNAVAILABLE' : 'REJECTED', response.status);
    }
    let data: unknown;
    try { data = await response.json(); } catch { throw new MercadoPagoError(method === 'POST' ? 'RECONCILE' : 'UNAVAILABLE'); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('id' in data) || typeof data.id !== 'string' || !('status' in data) || typeof data.status !== 'string') {
      throw new MercadoPagoError(method === 'POST' ? 'RECONCILE' : 'UNAVAILABLE');
    }
    if (!/^ORD[a-z0-9]{26}$/i.test(data.id) || (path && data.id !== path.split('/')[1])) {
      throw new MercadoPagoError(method === 'POST' ? 'RECONCILE' : 'UNAVAILABLE');
    }
    return data as Record<string, unknown>;
  }
}
