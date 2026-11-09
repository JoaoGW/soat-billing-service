import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from 'node:crypto';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
// Ordem por unidade de código UTF-16, igual ao sort padrão e independente de
// locale, para que a forma canônica seja idêntica em todos os serviços.
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : Number(a > b));
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (
    value &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const object = value as Record<string, Json>;
    return `{${Object.keys(object)
      .sort(byCodeUnit)
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`;
  }
  throw new Error('Envelope não é JSON válido');
}
function signingInput(body: unknown): Buffer {
  return Buffer.from(`soat-message-v1\n${canonical(body)}`, 'utf8');
}
export class MessageSigner {
  private readonly key: KeyObject;
  constructor(pem: string) {
    this.key = createPrivateKey(pem.replace(/\\n/g, '\n'));
    if (this.key.asymmetricKeyType !== 'ed25519')
      throw new Error('Chave de assinatura deve ser Ed25519');
  }
  sign(body: unknown): string {
    return sign(null, signingInput(body), this.key).toString('base64');
  }
}
export class MessageVerifier {
  private readonly key: KeyObject;
  constructor(
    pem: string,
    private readonly producer: string,
  ) {
    this.key = createPublicKey(pem.replace(/\\n/g, '\n'));
    if (this.key.asymmetricKeyType !== 'ed25519')
      throw new Error('Chave de verificação deve ser Ed25519');
  }
  verify(body: unknown, signature: unknown): boolean {
    try {
      if (
        !body ||
        typeof body !== 'object' ||
        !('producer' in body) ||
        body.producer !== this.producer ||
        typeof signature !== 'string' ||
        !/^[A-Za-z0-9+/]{86}==$/.test(signature)
      )
        return false;
      return verify(
        null,
        signingInput(body),
        this.key,
        Buffer.from(signature, 'base64'),
      );
    } catch {
      return false;
    }
  }
}
