import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { RecoverBillingOutbox } from '../../src/application/recuperar-outbox';
import { OutboxDispatcher } from '../../src/application/publicar-outbox';
const example = JSON.parse(readFileSync(resolve(process.cwd(), 'docs/contracts/messages/examples/billing.quote-issued.v1.json'), 'utf8')) as Record<string, unknown>;

const url = process.env.DATABASE_URL;
if (!url || !['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname) || !new URL(url).pathname.endsWith('_test')) throw new Error('Banco local de teste obrigatório');
const run = promisify(execFile);

describe('recuperação auditada da outbox Billing', () => {
  const db = new PrismaClient(); const ids: string[] = [];
  const create = async (overrides: Record<string, unknown> = {}) => {
    const messageId = `recovery-${randomUUID()}`; ids.push(messageId);
    const payload = { ...example, messageId, ...overrides };
    await db.outbox.create({ data: { messageId, type: 'billing.quote-issued.v1', payload: payload as Prisma.InputJsonObject, status: 'FAILED', attemptCount: 5 } });
    return { messageId, payload };
  };
  afterAll(async () => { await db.billingRecoveryAudit.deleteMany({ where: { messageId: { in: ids } } }); await db.outbox.deleteMany({ where: { messageId: { in: ids } } }); await db.$disconnect(); });

  it('CLI exige habilitação e schema válido, e rearma somente o evento original', async () => {
    const original = await create();
    const env = { ...process.env, ENABLE_BILLING_OUTBOX_RECOVERY: 'false', BILLING_RECOVERY_MESSAGE_ID: original.messageId, BILLING_RECOVERY_ACTOR: 'operator', BILLING_RECOVERY_REASON: 'BROKER_RESTORED' };
    await expect(run(process.execPath, ['scripts/operations/recover-outbox.cjs'], { env })).rejects.toThrow();
    expect((await db.outbox.findUniqueOrThrow({ where: { messageId: original.messageId } })).status).toBe('FAILED');
    const invalid = await create({ producer: 'fake' });
    await expect(run(process.execPath, ['scripts/operations/recover-outbox.cjs'], { env: { ...env, ENABLE_BILLING_OUTBOX_RECOVERY: 'true', BILLING_RECOVERY_MESSAGE_ID: invalid.messageId } })).rejects.toThrow();
    const invalidSchema = await create({ data: { ...(example.data as object), currency: 'USD' } });
    await expect(run(process.execPath, ['scripts/operations/recover-outbox.cjs'], { env: { ...env, ENABLE_BILLING_OUTBOX_RECOVERY: 'true', BILLING_RECOVERY_MESSAGE_ID: invalidSchema.messageId } })).rejects.toThrow();
    expect(await db.billingRecoveryAudit.count({ where: { messageId: invalidSchema.messageId } })).toBe(0);
    const command = await create({ type: 'billing.create-charge.v1' });
    await db.outbox.update({ where: { messageId: command.messageId }, data: { type: 'billing.create-charge.v1' } });
    await expect(run(process.execPath, ['scripts/operations/recover-outbox.cjs'], { env: { ...env, ENABLE_BILLING_OUTBOX_RECOVERY: 'true', BILLING_RECOVERY_MESSAGE_ID: command.messageId } })).rejects.toThrow();
    expect(await db.billingRecoveryAudit.count({ where: { messageId: command.messageId } })).toBe(0);
    const result = await run(process.execPath, ['scripts/operations/recover-outbox.cjs'], { env: { ...env, ENABLE_BILLING_OUTBOX_RECOVERY: 'true' } });
    expect(result.stdout).toMatch(/Evento rearmado; auditoria/);
    const stored = await db.outbox.findUniqueOrThrow({ where: { messageId: original.messageId } });
    expect(stored).toMatchObject({ status: 'PENDING', attemptCount: 0, payload: original.payload });
    const audits = await db.billingRecoveryAudit.findMany({ where: { messageId: original.messageId } });
    expect(audits).toHaveLength(1); expect(audits[0]).toMatchObject({ actor: 'operator', reasonCode: 'BROKER_RESTORED', eventType: 'billing.quote-issued.v1' });
    await expect(run(process.execPath, ['scripts/operations/recover-outbox.cjs'], { env: { ...env, ENABLE_BILLING_OUTBOX_RECOVERY: 'true' } })).rejects.toThrow();
    expect(await db.billingRecoveryAudit.count({ where: { messageId: original.messageId } })).toBe(1);
  });

  it('serializa recuperações concorrentes e mantém uma única auditoria', async () => {
    const item = await create();
    const service = new RecoverBillingOutbox(db, () => true);
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => service.execute({ messageId: item.messageId, actor: 'operator', reasonCode: 'BROKER_RESTORED' })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await db.billingRecoveryAudit.count({ where: { messageId: item.messageId } })).toBe(1);
  });

  it('publica o evento recuperado com o mesmo ID e conteúdo', async () => {
    const item = await create();
    await db.outbox.update({ where: { messageId: item.messageId }, data: { createdAt: new Date('1900-01-01T00:00:00Z') } });
    await new RecoverBillingOutbox(db, () => true).execute({ messageId: item.messageId, actor: 'operator', reasonCode: 'BROKER_RESTORED' });
    const publisher = { publish: jest.fn().mockResolvedValue(undefined) };
    expect(await new OutboxDispatcher(db, publisher).dispatchOne()).toBe('SENT');
    expect(publisher.publish).toHaveBeenCalledWith({ messageId: item.messageId, type: 'billing.quote-issued.v1', payload: item.payload });
    expect((await db.outbox.findUniqueOrThrow({ where: { messageId: item.messageId } })).status).toBe('SENT');
  });

  it('desfaz a auditoria quando falha o rearme transacional', async () => {
    const item = await create();
    await db.$executeRawUnsafe("CREATE FUNCTION test_block_billing_recovery() RETURNS trigger AS $$ BEGIN IF NEW.status = 'PENDING' THEN RAISE EXCEPTION 'falha simulada'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql");
    await db.$executeRawUnsafe('CREATE TRIGGER test_block_billing_recovery BEFORE UPDATE ON "Outbox" FOR EACH ROW EXECUTE FUNCTION test_block_billing_recovery()');
    try {
      const service = new RecoverBillingOutbox(db, () => true);
      await expect(service.execute({ messageId: item.messageId, actor: 'operator', reasonCode: 'BROKER_RESTORED' })).rejects.toThrow();
      expect(await db.billingRecoveryAudit.count({ where: { messageId: item.messageId } })).toBe(0);
      expect((await db.outbox.findUniqueOrThrow({ where: { messageId: item.messageId } })).status).toBe('FAILED');
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER test_block_billing_recovery ON "Outbox"');
      await db.$executeRawUnsafe('DROP FUNCTION test_block_billing_recovery()');
    }
  });
});
