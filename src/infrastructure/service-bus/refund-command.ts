import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { PrismaClient } from '@prisma/client';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { PrepareRefund, PrepareRefundService, SubmitRefundService, ConfirmRefundService } from '../../application/reembolsar-pagamento';

type Envelope = Omit<PrepareRefund, 'refundId' | 'paymentId' | 'cancelOperationId' | 'cancelEventId' | 'reason'> & { type: string; data: Pick<PrepareRefund, 'refundId' | 'paymentId' | 'cancelOperationId' | 'cancelEventId' | 'reason'> };
type Receiver = Pick<ServiceBusReceiver, 'completeMessage' | 'abandonMessage' | 'deadLetterMessage'>;
export function refundCommandValidator(directory: string): (value: unknown) => boolean {
  const ajv = new Ajv({ allErrors: true }); addFormats(ajv);
  const read = (file: string): object => JSON.parse(readFileSync(resolve(directory, file), 'utf8')) as object;
  ajv.addSchema(read('envelope.schema.json')); const validate = ajv.compile(read('billing.refund-payment.v1.schema.json'));
  return (value) => validate(value) === true;
}
/** The caller verifies OS signature before invoking this consumer. */
export class RefundCommandConsumer {
  constructor(private readonly db: PrismaClient, private readonly validate: (value: unknown) => boolean) {}
  async process(message: ServiceBusReceivedMessage, receiver: Receiver): Promise<void> {
    const body: unknown = message.body;
    if (!this.validate(body) || !body || typeof body !== 'object' || !('messageId' in body) || body.messageId !== message.messageId || (message.subject && message.subject !== 'billing.refund-payment.v1')) {
      await receiver.deadLetterMessage(message, { deadLetterReason: 'InvalidContract', deadLetterErrorDescription: 'Comando inválido' }); return;
    }
    const event = body as Envelope; const encoded = JSON.stringify(event); const consumer = 'billing.refund-staging';
    try {
      await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO "Inbox" ("consumer", "messageId", "operationId", "type", "payload", "status") VALUES (${consumer}, ${event.messageId}, ${event.operationId}, ${event.type}, ${encoded}::jsonb, 'PENDING') ON CONFLICT DO NOTHING`;
        const rows = await tx.$queryRaw<Array<{ matches: boolean }>>`SELECT ("operationId" = ${event.operationId} AND "type" = ${event.type} AND "payload" = ${encoded}::jsonb) AS "matches" FROM "Inbox" WHERE "consumer" = ${consumer} AND "messageId" = ${event.messageId}`;
        if (!rows[0]?.matches) throw new Error('Mensagem reutilizada com outro conteúdo');
      });
    } catch { await receiver.abandonMessage(message); return; }
    await receiver.completeMessage(message);
  }
}
/** Re-evaluates persisted commands when authenticated evidence arrives. */
export class RefundCommandProcessor {
  constructor(private readonly db: PrismaClient, private readonly prepare: PrepareRefundService, private readonly submit: SubmitRefundService, private readonly confirm: ConfirmRefundService, private readonly validate: (value: unknown) => boolean) {}
  async processOne(): Promise<'EMPTY' | 'PENDING' | 'REFUNDED' | 'RECONCILIACAO_NECESSARIA'> {
    const rows = await this.db.$queryRaw<Array<{ messageId: string; payload: unknown }>>`SELECT s."messageId", s."payload" FROM "Inbox" s WHERE s."consumer" = 'billing.refund-staging' AND s."status" = 'PENDING' AND EXISTS (SELECT 1 FROM "Inbox" e WHERE e."consumer" = 'billing.compensation-evidence' AND e."messageId" = s."payload"->'data'->>'cancelEventId' AND e."status" = 'APPLIED') ORDER BY random() LIMIT 1`;
    const row = rows[0]; if (!row) return 'EMPTY';
    if (!this.validate(row.payload)) throw new Error('Comando persistido inválido');
    const event = row.payload as Envelope; const input: PrepareRefund = { messageId: event.messageId, operationId: event.operationId, correlationId: event.correlationId, osId: event.osId, sagaId: event.sagaId, filialId: event.filialId, ...event.data };
    const evidence = await this.db.inbox.findUnique({ where: { consumer_messageId: { consumer: 'billing.compensation-evidence', messageId: input.cancelEventId } } });
    if (!evidence) return 'PENDING';
    try {
      await this.prepare.execute(input);
      const submitted = await this.submit.execute(input.operationId);
      const outcome = submitted === 'PENDING_CONFIRMATION' ? await this.confirm.execute(input.operationId) : submitted;
      if (outcome === 'REFUNDED' || outcome === 'RECONCILIACAO_NECESSARIA') {
        await this.db.inbox.updateMany({ where: { consumer: 'billing.refund-staging', messageId: event.messageId, status: 'PENDING' }, data: { status: outcome, appliedAt: new Date() } });
        return outcome;
      }
      return 'PENDING';
    } catch { return 'PENDING'; }
  }
}
