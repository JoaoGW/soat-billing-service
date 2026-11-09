import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { GenerateQuoteCommand, QuoteGenerationRejected } from '../../application/gerar-orcamento';
import { MessageVerifier } from './message-signature';
import { withMessageTrace } from '../observability/message-trace';

/** Recupera somente orçamento autenticado, usando o handler idempotente normal. */
export class RecoverBillingQuoteDlq {
  constructor(private readonly db: PrismaClient, private readonly verifier: Pick<MessageVerifier, 'verify'>, private readonly validate: (body: unknown) => boolean, private readonly handler: { execute(command: GenerateQuoteCommand): Promise<unknown> }) {}
  async execute(message: ServiceBusReceivedMessage, receiver: Pick<ServiceBusReceiver, 'completeMessage'>, input: { messageId: string; actor: string; reasonCode: string }): Promise<'APPLIED'> {
    if (!input || typeof input.messageId !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(input.messageId) || typeof input.actor !== 'string' || !/^[a-z0-9_@.-]{1,128}$/i.test(input.actor) || typeof input.reasonCode !== 'string' || !/^[A-Z0-9_]{3,80}$/.test(input.reasonCode)) throw new Error('Dados de recuperação inválidos');
    const body: unknown = message.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('messageId' in body) || body.messageId !== input.messageId || message.messageId !== input.messageId || message.subject !== 'billing.generate-quote.v1' || !('type' in body) || body.type !== message.subject || !('operationId' in body) || typeof body.operationId !== 'string' || !this.verifier.verify(body, message.applicationProperties?.signature) || !this.validate(body)) throw new Error('Comando não autenticado ou incompatível');
    await this.db.billingRecoveryAudit.create({ data: { id: randomUUID(), messageId: input.messageId, eventType: message.subject, actor: input.actor, reasonCode: input.reasonCode, payloadHash: createHash('sha256').update(JSON.stringify(body)).digest('hex') } });
    return withMessageTrace(body, async () => {
      try { await this.handler.execute(body as unknown as GenerateQuoteCommand); }
      catch (error) { if (!(error instanceof QuoteGenerationRejected)) throw error; }
      const [inbox, operation] = await Promise.all([
        this.db.inbox.findUnique({ where: { consumer_messageId: { consumer: 'billing.generate-quote.v1', messageId: input.messageId } } }),
        this.db.commandOperation.findUnique({ where: { consumer_operationId: { consumer: 'billing.generate-quote.v1', operationId: body.operationId as string } } }),
      ]);
      if (!inbox || inbox.status !== 'APPLIED' || inbox.operationId !== body.operationId || !operation) throw new Error('Comando não foi persistido');
      await receiver.completeMessage(message);
      return 'APPLIED' as const;
    });
  }
}
