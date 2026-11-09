import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { GenerateQuoteService } from '../../src/application/gerar-orcamento';
import { OutboxDispatcher } from '../../src/application/publicar-outbox';
import { createQuoteCommandValidator, ServiceBusCommandConsumer } from '../../src/infrastructure/service-bus/command-consumer';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL de teste é obrigatória');
const target = new URL(url);
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('A integração exige banco local com nome terminado em _test');

describe('integração local do transporte', () => {
  const prisma = new PrismaClient();
  afterAll(async () => { await prisma.$disconnect(); });

  it('valida comando, confirma após persistir e despacha o evento persistido', async () => {
    const dir = resolve(process.cwd(), 'docs/contracts/messages');
    const fixture = JSON.parse(readFileSync(resolve(dir, 'examples/billing.generate-quote.v1.json'), 'utf8')) as Record<string, unknown>;
    const tag = randomUUID();
    const body = { ...fixture, messageId: `msg-${tag}`, operationId: `op-${tag}`, osId: `os-${tag}`, sagaId: `saga-${tag}` };
    const message = { body, messageId: body.messageId, subject: 'billing.generate-quote.v1' } as ServiceBusReceivedMessage;
    const receiver = { completeMessage: jest.fn(), abandonMessage: jest.fn(), deadLetterMessage: jest.fn() };
    const consumer = new ServiceBusCommandConsumer(new GenerateQuoteService(prisma), createQuoteCommandValidator(dir));
    await consumer.process(message, receiver as unknown as ServiceBusReceiver);
    expect(receiver.completeMessage).toHaveBeenCalledTimes(1);
    expect(await prisma.quote.count({ where: { osId: body.osId } })).toBe(1);
    await consumer.process(message, receiver as unknown as ServiceBusReceiver);
    expect(receiver.completeMessage).toHaveBeenCalledTimes(2);
    expect(await prisma.quote.count({ where: { osId: body.osId } })).toBe(1);

    // Select only this event, without claiming events created by other suites.
    const event = await prisma.outbox.findFirstOrThrow({ where: { payload: { path: ['osId'], equals: body.osId } } });
    const fixedTime = new Date('2020-01-01T00:00:00Z');
    await prisma.outbox.update({ where: { messageId: event.messageId }, data: { nextAttemptAt: fixedTime, createdAt: fixedTime } });
    const publisher = { publish: jest.fn().mockResolvedValue(undefined) };
    await expect(new OutboxDispatcher(prisma, publisher).dispatchOne(fixedTime)).resolves.toBe('SENT');
    expect(publisher.publish).toHaveBeenCalledWith(expect.objectContaining({ messageId: event.messageId, type: 'billing.quote-issued.v1' }));
  });

  it('registra falha definitiva antes do ACK e deduplica a reentrega', async () => {
    const dir = resolve(process.cwd(), 'docs/contracts/messages');
    const fixture = JSON.parse(readFileSync(resolve(dir, 'examples/billing.generate-quote.v1.json'), 'utf8')) as { data: Record<string, unknown> };
    const tag = randomUUID();
    const body = { ...fixture, messageId: `failed-msg-${tag}`, operationId: `failed-op-${tag}`, osId: `failed-os-${tag}`, sagaId: `failed-saga-${tag}`, data: { ...fixture.data, expiresAt: '2020-01-01T00:00:00Z' } };
    const message = { body, messageId: body.messageId, subject: 'billing.generate-quote.v1' } as ServiceBusReceivedMessage;
    const receiver = { completeMessage: jest.fn(), abandonMessage: jest.fn(), deadLetterMessage: jest.fn() };
    const consumer = new ServiceBusCommandConsumer(new GenerateQuoteService(prisma), createQuoteCommandValidator(dir));
    await consumer.process(message, receiver as unknown as ServiceBusReceiver);
    const retryBody = { ...body, messageId: `failed-msg-retry-${tag}` };
    await consumer.process({ ...message, body: retryBody, messageId: retryBody.messageId }, receiver as unknown as ServiceBusReceiver);
    expect(receiver.completeMessage).toHaveBeenCalledTimes(2);
    expect(receiver.abandonMessage).not.toHaveBeenCalled();
    expect(await prisma.quote.count({ where: { osId: body.osId } })).toBe(0);
    const events = await prisma.outbox.findMany({ where: { payload: { path: ['osId'], equals: body.osId } } });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('billing.quote-failed.v1');
    const ajv = new Ajv();
    addFormats(ajv);
    ajv.addSchema(JSON.parse(readFileSync(resolve(dir, 'envelope.schema.json'), 'utf8')));
    expect(ajv.validate(JSON.parse(readFileSync(resolve(dir, 'billing.quote-failed.v1.schema.json'), 'utf8')), events[0].payload)).toBe(true);
  });

  it('não confirma falha de negócio se não puder gravar o evento', async () => {
    const dir = resolve(process.cwd(), 'docs/contracts/messages');
    const fixture = JSON.parse(readFileSync(resolve(dir, 'examples/billing.generate-quote.v1.json'), 'utf8')) as { data: Record<string, unknown> };
    const tag = randomUUID();
    const body = { ...fixture, messageId: `fail-rollback-${tag}`, operationId: `op-rollback-${tag}`, osId: `os-rollback-${tag}`, sagaId: `saga-rollback-${tag}`, data: { ...fixture.data, expiresAt: '2020-01-01T00:00:00Z' } };
    const message = { body, messageId: body.messageId, subject: 'billing.generate-quote.v1' } as ServiceBusReceivedMessage;
    const receiver = { completeMessage: jest.fn(), abandonMessage: jest.fn(), deadLetterMessage: jest.fn() };
    const consumer = new ServiceBusCommandConsumer(new GenerateQuoteService(prisma), createQuoteCommandValidator(dir));
    await prisma.$executeRawUnsafe('CREATE FUNCTION test_reject_failure_event() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION \'outbox unavailable\'; END; $$ LANGUAGE plpgsql');
    await prisma.$executeRawUnsafe('CREATE TRIGGER test_reject_failure_event BEFORE INSERT ON "Outbox" FOR EACH ROW EXECUTE FUNCTION test_reject_failure_event()');
    try {
      await consumer.process(message, receiver as unknown as ServiceBusReceiver);
      expect(receiver.completeMessage).not.toHaveBeenCalled();
      expect(receiver.abandonMessage).toHaveBeenCalledTimes(1);
      expect(await prisma.inbox.count({ where: { operationId: body.operationId } })).toBe(0);
      expect(await prisma.commandOperation.count({ where: { operationId: body.operationId } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER test_reject_failure_event ON "Outbox"');
      await prisma.$executeRawUnsafe('DROP FUNCTION test_reject_failure_event()');
    }
  });
});
