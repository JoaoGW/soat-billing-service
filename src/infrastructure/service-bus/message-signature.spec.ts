import { generateKeyPairSync } from 'node:crypto';
import { MessageSigner, MessageVerifier } from './message-signature';
describe('assinatura dos envelopes', () => {
  it('autentica produtor e conteúdo independente da ordem de propriedades', () => {
    const keys = generateKeyPairSync('ed25519');
    const privatePem = keys.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const publicPem = keys.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const signer = new MessageSigner(privatePem);
    const verifier = new MessageVerifier(publicPem, 'soat-os-service');
    const body = {
      producer: 'soat-os-service',
      data: { value: 10, id: 'x' },
      type: 'test',
    };
    const signature = signer.sign(body);
    expect(
      verifier.verify(
        {
          type: 'test',
          data: { id: 'x', value: 10 },
          producer: 'soat-os-service',
        },
        signature,
      ),
    ).toBe(true);
    expect(
      verifier.verify({ ...body, data: { id: 'x', value: 11 } }, signature),
    ).toBe(false);
    expect(verifier.verify({ ...body, producer: 'other' }, signature)).toBe(
      false,
    );
    expect(verifier.verify(body, 'bad')).toBe(false);
    expect(verifier.verify(body, undefined)).toBe(false);
  });
});
