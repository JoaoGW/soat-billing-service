import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { PrismaClient } from '@prisma/client';
import { GenerateQuoteCommand, GenerateQuoteService } from '../../src/application/gerar-orcamento';
import { QuoteDecisionService } from '../../src/application/decidir-orcamento';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL de teste é obrigatória');
const target = new URL(url);
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('A integração exige banco local com nome terminado em _test');

describe('geração de orçamento em PostgreSQL', () => {
  const prisma = new PrismaClient();
  const service = new GenerateQuoteService(prisma);
  const tag = randomUUID();
  const command: GenerateQuoteCommand = { messageId: `m-${tag}`, operationId: `op-${tag}`, osId: `os-${tag}`, sagaId: `s-${tag}`, filialId: 'filial', correlationId: `corr-${tag}`, data: { clienteId: 'cliente', contato: 'cliente@example.test', diagnosisId: 'diag', diagnosisVersion: 1, expiresAt: '2040-01-01T00:00:00Z', items: [{ sourceId: 'peca', itemType: 'PART', quantity: 2, unitPriceInCents: 750 }] } };
  afterAll(async () => { await prisma.$disconnect(); });

  it('deduplica reentregas simultâneas e grava uma única intenção de notificação', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => service.execute({ ...command, messageId: `${command.messageId}-${i}` })));
    expect(new Set(results.map((r) => r.quoteId)).size).toBe(1);
    const quoteId = results[0].quoteId;
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId }, include: { items: true } });
    expect(quote.totalInCents).toBe(1500);
    expect(quote.items).toHaveLength(1);
    expect(await prisma.notification.count({ where: { quoteId } })).toBe(1);
    expect(await prisma.outbox.count({ where: { payload: { path: ['osId'], equals: command.osId } } })).toBe(1);
    const event = await prisma.outbox.findFirstOrThrow({ where: { payload: { path: ['osId'], equals: command.osId } } });
    const dir = resolve(__dirname, '../../docs/contracts/messages');
    const ajv = new Ajv();
    addFormats(ajv);
    ajv.addSchema(JSON.parse(readFileSync(resolve(dir, 'envelope.schema.json'), 'utf8')));
    expect(ajv.validate(JSON.parse(readFileSync(resolve(dir, `${event.type}.schema.json`), 'utf8')), event.payload)).toBe(true);
    expect(await prisma.inbox.count({ where: { operationId: command.operationId } })).toBe(4);
    await expect(service.execute({ ...command, messageId: 'alterada', data: { ...command.data, contato: 'outro@example.test' } })).rejects.toThrow('outro conteúdo');
  });

  it('reverte todos os efeitos se falhar a criação da notificação', async () => {
    const failing = { ...command, messageId: `fail-m-${tag}`, operationId: `fail-op-${tag}`, osId: `fail-os-${tag}` };
    await prisma.$executeRawUnsafe('CREATE FUNCTION test_reject_notification() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION \'notification unavailable\'; END; $$ LANGUAGE plpgsql');
    await prisma.$executeRawUnsafe('CREATE TRIGGER test_reject_notification BEFORE INSERT ON "Notification" FOR EACH ROW EXECUTE FUNCTION test_reject_notification()');
    try {
      await expect(service.execute(failing)).rejects.toThrow();
      expect(await prisma.quote.count({ where: { osId: failing.osId } })).toBe(0);
      expect(await prisma.outbox.count({ where: { payload: { path: ['osId'], equals: failing.osId } } })).toBe(0);
      expect(await prisma.inbox.count({ where: { operationId: failing.operationId } })).toBe(0);
      expect(await prisma.commandOperation.count({ where: { operationId: failing.operationId } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER test_reject_notification ON "Notification"');
      await prisma.$executeRawUnsafe('DROP FUNCTION test_reject_notification()');
    }
  });

  it('permite decidir o orçamento gerado sem acesso a outros bancos', async () => {
    const next = { ...command, messageId: `flow-m-${tag}`, operationId: `flow-op-${tag}`, osId: `flow-os-${tag}` };
    const issued = await service.execute(next);
    const decision = await new QuoteDecisionService(prisma).execute({ quoteId: issued.quoteId, clientId: next.data.clienteId, version: issued.version, decision: 'APPROVED', idempotencyKey: `decision-${tag}`, correlationId: next.correlationId });
    expect(decision.decision).toBe('APPROVED');
    const events = await prisma.outbox.findMany({ where: { payload: { path: ['osId'], equals: next.osId } } });
    expect(events.map((event) => event.type).sort()).toEqual(['billing.quote-approved.v1', 'billing.quote-issued.v1']);
  });
});
