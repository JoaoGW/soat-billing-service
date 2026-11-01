import { createHmac } from 'node:crypto';
import { validMercadoPagoSignature } from './webhook-signature';

describe('assinatura webhook Mercado Pago', () => {
  const secret = 'test-secret'; const requestId = 'request-1'; const dataId = 'ORDABC123'; const ts = '1742505638683';
  const hmac = createHmac('sha256', secret).update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex');
  const input = { secret, requestId, dataId, signature: `ts=${ts},v1=${hmac}` };
  it('valida HMAC incluindo data.id, request id e timestamp', () => { expect(validMercadoPagoSignature(input)).toBe(true); });
  it('rejeita adulteração e campos ausentes ou ambíguos', () => {
    expect(validMercadoPagoSignature({ ...input, dataId: 'outro' })).toBe(false);
    expect(validMercadoPagoSignature({ ...input, requestId: '' })).toBe(false);
    expect(validMercadoPagoSignature({ ...input, signature: `ts=${ts},v1=${hmac},v1=${hmac}` })).toBe(false);
    expect(validMercadoPagoSignature({ ...input, signature: 'ts=wrong,v1=00' })).toBe(false);
  });
});
