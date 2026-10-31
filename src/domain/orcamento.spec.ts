import { calculateTotal, decide, Quote } from './orcamento';

const issued: Quote = { id: 'q1', clientId: 'client1', version: 1, revision: 0, status: 'ISSUED', expiresAt: new Date('2030-01-02T00:00:00Z') };
const now = new Date('2030-01-01T00:00:00Z');

describe('orçamento', () => {
  it('calcula valores inteiros em centavos e rejeita itens inválidos', () => {
    expect(calculateTotal([{ quantity: 2, unitPriceInCents: 1599 }, { quantity: 1, unitPriceInCents: 800 }])).toBe(3998);
    expect(() => calculateTotal([{ quantity: 1, unitPriceInCents: 1.5 }])).toThrow('Item inválido');
    expect(() => calculateTotal([{ quantity: 2, unitPriceInCents: Number.MAX_SAFE_INTEGER }])).toThrow('Total fora do limite');
  });
  it('aprova a versão vigente e repete sem novo efeito', () => {
    const result = decide(issued, 'client1', 1, 'APPROVED', now);
    expect(result).toMatchObject({ changed: true, quote: { status: 'APPROVED', revision: 1 } });
    expect(decide(result.quote, 'client1', 1, 'APPROVED', now).changed).toBe(false);
    expect(() => decide(result.quote, 'client1', 1, 'REJECTED', now)).toThrow('conflitante');
  });
  it('rejeita outro cliente, versão antiga e prazo vencido', () => {
    expect(() => decide(issued, 'other', 1, 'APPROVED', now)).toThrow('Acesso negado');
    expect(() => decide(issued, 'client1', 2, 'APPROVED', now)).toThrow('Versão divergente');
    expect(() => decide(issued, 'client1', 1, 'APPROVED', issued.expiresAt)).toThrow('expirado');
  });
});
