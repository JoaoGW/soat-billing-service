import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

export type BillingEventValidator = (type: string, payload: unknown) => boolean;

/** Rearma somente o evento original; destinatários devem deduplicar o messageId. */
export class RecoverBillingOutbox {
  constructor(private readonly db: PrismaClient, private readonly validate: BillingEventValidator) {}

  async execute(input: { messageId: string; actor: string; reasonCode: string }, now = new Date()): Promise<string> {
    if (!input || typeof input.messageId !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(input.messageId) || typeof input.actor !== 'string' || !/^[a-z0-9_@.-]{1,128}$/i.test(input.actor) || typeof input.reasonCode !== 'string' || !/^[A-Z0-9_]{3,80}$/.test(input.reasonCode) || !Number.isFinite(now.getTime())) throw new Error('Dados de recuperação inválidos');
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "messageId" FROM "Outbox" WHERE "messageId"=${input.messageId} FOR UPDATE`;
      const message = await tx.outbox.findUnique({ where: { messageId: input.messageId } });
      if (!message || message.status !== 'FAILED' || message.claimOwner !== null || message.claimUntil !== null || message.publishedAt !== null) throw new Error('Evento não elegível para recuperação');
      const payload = message.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !('messageId' in payload) || payload.messageId !== message.messageId || !('type' in payload) || payload.type !== message.type || !('producer' in payload) || payload.producer !== 'soat-billing-service' || !this.validate(message.type, payload)) throw new Error('Contrato do evento inválido');
      const id = randomUUID();
      await tx.billingRecoveryAudit.create({ data: { id, messageId: message.messageId, eventType: message.type, actor: input.actor, reasonCode: input.reasonCode, payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), occurredAt: now } });
      const updated = await tx.outbox.updateMany({ where: { messageId: message.messageId, status: 'FAILED', claimOwner: null, claimUntil: null, publishedAt: null }, data: { status: 'PENDING', attemptCount: 0, nextAttemptAt: now } });
      if (updated.count !== 1) throw new Error('Evento mudou durante recuperação');
      return id;
    });
  }
}
