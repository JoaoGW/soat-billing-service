import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { QuoteDecisionService } from '../../src/application/decidir-orcamento';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL de teste é obrigatória');
const target = new URL(url);
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) || !target.pathname.endsWith('_test')) {
  throw new Error('A integração exige banco local com nome terminado em _test');
}

describe('decisão em PostgreSQL', () => {
  const prisma = new PrismaClient();
  const service = new QuoteDecisionService(prisma);
  const tag = randomUUID();
  const quoteId = `q-${tag}`;
  const osId = `os-${tag}`;
  const input = { quoteId, clientId: `c-${tag}`, version: 1, decision: 'APPROVED' as const, idempotencyKey: `key-${tag}`, correlationId: `corr-${tag}` };
  beforeAll(async () => {
    await prisma.quote.create({ data: { id: quoteId, osId, sagaId: `s-${tag}`, filialId: 'filial', clientId: input.clientId, version: 1, totalInCents: 1000, status: 'ISSUED', expiresAt: new Date(Date.now() + 3600000) } });
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('serializa decisões conflitantes e grava somente um efeito e um evento', async () => {
    const results = await Promise.allSettled([
      service.execute(input),
      service.execute({ ...input, idempotencyKey: `reject-${tag}`, decision: 'REJECTED' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const loser = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(loser?.reason).toEqual(expect.objectContaining({ message: expect.stringContaining('Decisão conflitante') }));
    expect(await prisma.quoteDecision.count({ where: { quoteId } })).toBe(1);
    const events = await prisma.outbox.findMany({ where: { payload: { path: ['osId'], equals: osId } } });
    expect(events).toHaveLength(1);
    const contractDir = resolve(__dirname, '../../docs/contracts/messages');
    const ajv = new Ajv();
    addFormats(ajv);
    ajv.addSchema(JSON.parse(readFileSync(resolve(contractDir, 'envelope.schema.json'), 'utf8')));
    const schema = JSON.parse(readFileSync(resolve(contractDir, `${events[0].type}.schema.json`), 'utf8'));
    expect(ajv.validate(schema, events[0].payload)).toBe(true);
    const winner = results.find((r) => r.status === 'fulfilled');
    if (!winner || winner.status !== 'fulfilled') throw new Error('Sem vencedor');
    const retryInput = winner.value.decision === 'APPROVED' ? input : { ...input, idempotencyKey: `reject-${tag}`, decision: 'REJECTED' as const };
    await expect(service.execute(retryInput)).resolves.toEqual(winner.value);
    await expect(service.execute({ ...retryInput, decision: retryInput.decision === 'APPROVED' ? 'REJECTED' : 'APPROVED' })).rejects.toThrow('idempotência');
    expect(await prisma.outbox.count({ where: { payload: { path: ['osId'], equals: osId } } })).toBe(1);
  });

  it('rejeita cliente errado sem gravar efeitos', async () => {
    await expect(service.execute({ ...input, clientId: 'outro', idempotencyKey: 'other' })).rejects.toThrow('Acesso negado');
    expect(await prisma.idempotencyRequest.count({ where: { actorId: 'outro' } })).toBe(0);
  });

  it('repetições concorrentes da mesma chave convergem para uma única decisão', async () => {
    const id = `same-${tag}`;
    await prisma.quote.create({ data: { id, osId: `same-os-${tag}`, sagaId: `same-s-${tag}`, filialId: 'filial', clientId: input.clientId, version: 1, totalInCents: 1000, status: 'ISSUED', expiresAt: new Date(Date.now() + 3600000) } });
    const same = { ...input, quoteId: id, idempotencyKey: `same-key-${tag}` };
    const results = await Promise.all(Array.from({ length: 4 }, () => service.execute(same)));
    expect(results).toHaveLength(4);
    expect(results.every((result) => result.quoteId === id && result.decision === 'APPROVED')).toBe(true);
    expect(await prisma.quoteDecision.count({ where: { quoteId: id } })).toBe(1);
    expect(await prisma.outbox.count({ where: { payload: { path: ['osId'], equals: `same-os-${tag}` } } })).toBe(1);
  });

  it('reverte decisão e idempotência quando a outbox não pode ser gravada', async () => {
    const id = `rollback-${tag}`;
    await prisma.quote.create({ data: { id, osId: `rollback-os-${tag}`, sagaId: `rollback-s-${tag}`, filialId: 'filial', clientId: input.clientId, version: 1, totalInCents: 1000, status: 'ISSUED', expiresAt: new Date(Date.now() + 3600000) } });
    await prisma.$executeRawUnsafe('CREATE FUNCTION test_reject_outbox() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION \'outbox indisponível\'; END; $$ LANGUAGE plpgsql');
    await prisma.$executeRawUnsafe('CREATE TRIGGER test_reject_outbox BEFORE INSERT ON "Outbox" FOR EACH ROW EXECUTE FUNCTION test_reject_outbox()');
    try {
      await expect(service.execute({ ...input, quoteId: id, idempotencyKey: `rollback-key-${tag}` })).rejects.toThrow();
      const quote = await prisma.quote.findUniqueOrThrow({ where: { id } });
      expect(quote.status).toBe('ISSUED');
      expect(quote.revision).toBe(0);
      expect(await prisma.quoteDecision.count({ where: { quoteId: id } })).toBe(0);
      expect(await prisma.idempotencyRequest.count({ where: { key: `rollback-key-${tag}` } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER test_reject_outbox ON "Outbox"');
      await prisma.$executeRawUnsafe('DROP FUNCTION test_reject_outbox()');
    }
  });
});
