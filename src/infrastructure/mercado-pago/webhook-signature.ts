import { createHmac, timingSafeEqual } from 'node:crypto';

/** Authenticity only. The caller must persist and deduplicate before acknowledging,
 * then query the provider and verify the order, amount, currency and status. */
export function validMercadoPagoSignature(input: { secret: string; signature: string; requestId: string; dataId: string }): boolean {
  const { secret, signature, requestId, dataId } = input;
  if (!secret || !signature || !requestId || !dataId || /[;\r\n]/.test(requestId) || !/^[a-z0-9_-]+$/i.test(dataId)) return false;
  const fields = new Map<string, string>();
  for (const part of signature.split(',')) {
    const match = /^\s*(ts|v1)=([^,\s]+)\s*$/.exec(part);
    if (!match || fields.has(match[1])) return false;
    fields.set(match[1], match[2]);
  }
  const timestamp = fields.get('ts');
  const hash = fields.get('v1');
  if (!timestamp || !/^\d{1,20}$/.test(timestamp) || !hash || !/^[0-9a-f]{64}$/i.test(hash)) return false;
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${timestamp};`;
  const expected = createHmac('sha256', secret).update(manifest).digest();
  return timingSafeEqual(expected, Buffer.from(hash, 'hex'));
}
