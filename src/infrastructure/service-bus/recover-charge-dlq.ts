import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { PrepareCharge, chargeFingerprint } from '../../application/preparar-cobranca';
import { MessageVerifier } from './message-signature';
import { withMessageTrace } from '../observability/message-trace';

/** Confirma apenas cobrança já concluída ou expirada, sem chamar o provedor. */
export class RecoverBillingChargeDlq {
  constructor(private readonly db: PrismaClient, private readonly verifier: Pick<MessageVerifier, 'verify'>, private readonly validate: (body: unknown) => boolean, private readonly validateEvent: (type: string, body: unknown) => boolean) {}
  async execute(message: ServiceBusReceivedMessage, receiver: Pick<ServiceBusReceiver, 'completeMessage'>, input: { messageId: string; actor: string; reasonCode: string }): Promise<'VERIFIED'> {
    if (!input || typeof input.messageId !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(input.messageId) || typeof input.actor !== 'string' || !/^[a-z0-9_@.-]{1,128}$/i.test(input.actor) || typeof input.reasonCode !== 'string' || !/^[A-Z0-9_]{3,80}$/.test(input.reasonCode)) throw new Error('Dados de recuperação inválidos');
    const body: unknown = message.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('messageId' in body) || body.messageId !== input.messageId || message.messageId !== input.messageId || message.subject !== 'billing.create-charge.v1' || !('type' in body) || body.type !== message.subject || !('operationId' in body) || typeof body.operationId !== 'string' || !this.verifier.verify(body, message.applicationProperties?.signature) || !this.validate(body)) throw new Error('Comando não autenticado ou incompatível');
    const envelope = body as unknown as Pick<PrepareCharge, 'messageId' | 'operationId' | 'correlationId' | 'osId' | 'sagaId' | 'filialId'> & { data: Omit<PrepareCharge, 'messageId' | 'operationId' | 'correlationId' | 'osId' | 'sagaId' | 'filialId'> };
    const d = envelope.data;
    const command: PrepareCharge = { messageId: envelope.messageId, operationId: envelope.operationId, correlationId: envelope.correlationId, osId: envelope.osId, sagaId: envelope.sagaId, filialId: envelope.filialId, quoteId: d.quoteId, quoteVersion: d.quoteVersion, chargeId: d.chargeId, clientId: d.clientId, totalInCents: d.totalInCents, currency: d.currency, reservationId: d.reservationId, externalPosId: d.externalPosId, expiresAt: d.expiresAt };
    const fingerprint = chargeFingerprint(command);
    return withMessageTrace(body, async () => {
      await this.db.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "ChargeAttempt" WHERE "operationId" = ${command.operationId} FOR UPDATE`;
        const attempt = await tx.chargeAttempt.findUnique({ where: { operationId: command.operationId }, include: { charge: true } });
        const inbox = await tx.inbox.findUnique({ where: { consumer_messageId: { consumer: 'billing.create-charge.v1', messageId: input.messageId } } });
        const attemptResult = attempt?.result as { fingerprint?: unknown; messageId?: unknown } | null | undefined;
        const inboxResult = inbox?.payload as { fingerprint?: unknown } | null | undefined;
        if (!attempt || !['CREATED', 'EXPIRED'].includes(attempt.status) || attempt.chargeId !== command.chargeId || attempt.charge.quoteId !== command.quoteId || attempt.charge.osId !== command.osId || attempt.charge.amountInCents !== command.totalInCents || attempt.charge.currency !== command.currency || attempt.charge.externalReference !== command.chargeId || attempt.charge.expiresAt.toISOString() !== new Date(command.expiresAt).toISOString() || (attempt.status === 'CREATED' && !attempt.charge.providerOrderId) || (attempt.status === 'EXPIRED' && (attempt.charge.status !== 'EXPIRED' || attempt.charge.providerOrderId !== null)) || attemptResult?.fingerprint !== fingerprint || !inbox || inbox.status !== 'APPLIED' || inbox.operationId !== command.operationId || inboxResult?.fingerprint !== fingerprint) throw new Error('Resultado financeiro não comprovado');
        const eventType = attempt.status === 'CREATED' ? 'billing.charge-created.v1' : 'billing.charge-failed.v1';
        const events = await tx.outbox.findMany({ where: { type: eventType, payload: { path: ['operationId'], equals: command.operationId } } });
        const matches = events.filter(row => {
          const event = row.payload as { messageId?: unknown; type?: unknown; operationId?: unknown; causationId?: unknown; osId?: unknown; sagaId?: unknown; filialId?: unknown; data?: Record<string, unknown> } | null;
          if (!event || event.messageId !== row.messageId || event.type !== eventType || event.operationId !== command.operationId || typeof attemptResult?.messageId !== 'string' || event.causationId !== attemptResult.messageId || event.osId !== command.osId || event.sagaId !== command.sagaId || event.filialId !== command.filialId || !event.data || event.data.chargeId !== command.chargeId || event.data.quoteId !== command.quoteId || event.data.quoteVersion !== command.quoteVersion || event.data.reservationId !== command.reservationId || !this.validateEvent(eventType, event)) return false;
          return attempt.status === 'EXPIRED' ? event.data.reasonCode === 'EXPIRED' : event.data.providerOrderId === attempt.charge.providerOrderId && event.data.externalReference === attempt.charge.externalReference && typeof event.data.expiresAt === 'string' && Date.parse(event.data.expiresAt) === attempt.charge.expiresAt.getTime() && event.data.totalInCents === command.totalInCents && event.data.currency === command.currency && event.data.clientId === command.clientId;
        });
        if (matches.length !== 1) throw new Error('Evento financeiro não comprovado');
        await tx.billingRecoveryAudit.create({ data: { id: randomUUID(), messageId: input.messageId, eventType: message.subject!, actor: input.actor, reasonCode: input.reasonCode, payloadHash: createHash('sha256').update(JSON.stringify(body)).digest('hex') } });
      });
      await receiver.completeMessage(message);
      return 'VERIFIED' as const;
    });
  }
}
