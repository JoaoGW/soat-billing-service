import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { MessageVerifier } from './message-signature';
import { withMessageTrace } from '../observability/message-trace';

type Receiver = Pick<ServiceBusReceiver, 'completeMessage' | 'abandonMessage' | 'deadLetterMessage'>;

/** Persiste a evidência autenticada pelo consumidor usual antes de confirmar a DLQ. */
export class RecoverBillingEvidenceDlq {
  constructor(private readonly db: PrismaClient, private readonly verifier: Pick<MessageVerifier, 'verify'>, private readonly validate: (body: unknown) => boolean, private readonly consumer: { process(message: ServiceBusReceivedMessage, receiver: Receiver): Promise<void> }) {}
  async execute(message: ServiceBusReceivedMessage, receiver: Pick<Receiver, 'completeMessage'>, input: { messageId: string; actor: string; reasonCode: string }): Promise<'APPLIED'> {
    if (!input || typeof input.messageId !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(input.messageId) || typeof input.actor !== 'string' || !/^[a-z0-9_@.-]{1,128}$/i.test(input.actor) || typeof input.reasonCode !== 'string' || !/^[A-Z0-9_]{3,80}$/.test(input.reasonCode)) throw new Error('Dados de recuperação inválidos');
    const body: unknown = message.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('messageId' in body) || body.messageId !== input.messageId || message.messageId !== input.messageId || message.subject !== 'execution.work-cancelled.v1' || !('type' in body) || body.type !== message.subject || !('operationId' in body) || typeof body.operationId !== 'string' || !this.verifier.verify(body, message.applicationProperties?.signature) || !this.validate(body)) throw new Error('Evidência não autenticada ou incompatível');
    await this.db.billingRecoveryAudit.create({ data: { id: randomUUID(), messageId: input.messageId, eventType: message.subject, actor: input.actor, reasonCode: input.reasonCode, payloadHash: createHash('sha256').update(JSON.stringify(body)).digest('hex') } });
    return withMessageTrace(body, async () => {
      let persisted = false;
      const settlement = {
        completeMessage: async () => { persisted = true; },
        abandonMessage: async () => { throw new Error('Falha ao persistir evidência'); },
        deadLetterMessage: async () => { throw new Error('Evidência recusada'); },
      } as unknown as Receiver;
      await this.consumer.process(message, settlement);
      if (!persisted) throw new Error('Evidência não foi persistida');
      const rows = await this.db.$queryRaw<Array<{ matches: boolean }>>`SELECT ("operationId" = ${body.operationId as string} AND "type" = ${message.subject} AND "payload" = ${JSON.stringify(body)}::jsonb AND "status" = 'APPLIED') AS "matches" FROM "Inbox" WHERE "consumer" = 'billing.compensation-evidence' AND "messageId" = ${input.messageId}`;
      if (!rows[0]?.matches) throw new Error('Evidência não foi persistida');
      await receiver.completeMessage(message);
      return 'APPLIED' as const;
    });
  }
}
