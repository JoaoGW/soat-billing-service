import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { validMercadoPagoSignature } from '../infrastructure/mercado-pago/webhook-signature';

export class InvalidWebhookSignature extends Error { constructor() { super('Assinatura inválida'); } }
export class InvalidWebhookPayload extends Error { constructor() { super('Notificação inválida'); } }

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
// Ordem por unidade de código UTF-16, igual ao sort padrão e independente de
// locale, para que a forma canônica seja idêntica em todos os serviços.
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : Number(a > b));
function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort(byCodeUnit).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Only persists a notification; it never treats its contents as proof of payment. */
export class RegisterMercadoPagoWebhook {
  constructor(private readonly db: Pick<PrismaClient, 'receivedWebhook'>, private readonly secret: string) {
    if (!secret) throw new Error('Segredo do webhook ausente');
  }

  async execute(input: { signature: string; requestId: string; dataId: string; body: unknown }): Promise<'RECORDED' | 'DUPLICATE'> {
    if (!validMercadoPagoSignature({ secret: this.secret, signature: input.signature, requestId: input.requestId, dataId: input.dataId })) throw new InvalidWebhookSignature();
    let encoded: string;
    try { encoded = JSON.stringify(input.body); } catch { throw new InvalidWebhookPayload(); }
    if (!encoded || Buffer.byteLength(encoded, 'utf8') > 262144) throw new InvalidWebhookPayload();
    const value: unknown = JSON.parse(encoded);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('type' in value) || value.type !== 'order' ||
        !('action' in value) || typeof value.action !== 'string' || !value.action || !('data' in value) ||
        !value.data || typeof value.data !== 'object' || !('id' in value.data) || value.data.id !== input.dataId) throw new InvalidWebhookPayload();
    const eventId = createHash('sha256').update(canonical(value as Json)).digest('hex');
    const result = await this.db.receivedWebhook.createMany({
      data: [{ provider: 'mercado-pago-orders', eventId, payload: value as Prisma.InputJsonValue, status: 'RECEIVED' }],
      skipDuplicates: true,
    });
    return result.count ? 'RECORDED' : 'DUPLICATE';
  }
}
