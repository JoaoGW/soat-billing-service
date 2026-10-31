export type QuoteLine = { quantity: number; unitPriceInCents: number };
export type Decision = 'APPROVED' | 'REJECTED';
export type Quote = {
  id: string;
  clientId: string;
  version: number;
  revision: number;
  status: 'ISSUED' | Decision | 'EXPIRED' | 'CANCELLED';
  expiresAt: Date;
};

export function calculateTotal(lines: QuoteLine[]): number {
  if (!lines.length) throw new Error('Orçamento sem itens');
  let total = 0;
  for (const { quantity, unitPriceInCents } of lines) {
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isSafeInteger(unitPriceInCents) || unitPriceInCents < 0) throw new Error('Item inválido');
    total += quantity * unitPriceInCents;
    if (!Number.isSafeInteger(total)) throw new Error('Total fora do limite');
  }
  return total;
}

// Persist the returned transition with CAS on revision, decision and outbox in
// one local SQL transaction. A retry with the same decision must not republish.
export function decide(quote: Quote, clientId: string, version: number, decision: Decision, now: Date): { quote: Quote; changed: boolean } {
  if (quote.clientId !== clientId) throw new Error('Acesso negado');
  if (quote.version !== version) throw new Error('Versão divergente');
  if (quote.status === decision) return { quote, changed: false };
  if (quote.status !== 'ISSUED') throw new Error('Decisão conflitante');
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(quote.expiresAt.getTime()) || now >= quote.expiresAt) throw new Error('Orçamento expirado');
  return { quote: { ...quote, status: decision, revision: quote.revision + 1 }, changed: true };
}
