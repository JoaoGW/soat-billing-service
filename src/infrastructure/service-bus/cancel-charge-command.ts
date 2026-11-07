import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { PrismaClient } from '@prisma/client';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { CancelChargeInput, PrepareChargeCancellation, CancelChargeService } from '../../application/cancelar-cobranca';

type Envelope = Omit<CancelChargeInput, 'chargeId' | 'reservationId' | 'cancelOperationId' | 'cancelEventId'> & { type: string; data: Pick<CancelChargeInput, 'chargeId' | 'reservationId' | 'cancelOperationId' | 'cancelEventId'> };
type Receiver = Pick<ServiceBusReceiver, 'completeMessage' | 'abandonMessage' | 'deadLetterMessage'>;
const staging = 'billing.cancel-charge-staging';
export function cancelChargeValidator(directory: string): (value: unknown) => boolean {
  const ajv = new Ajv({ allErrors: true }); addFormats(ajv);
  const read = (file: string): object => JSON.parse(readFileSync(resolve(directory, file), 'utf8')) as object;
  ajv.addSchema(read('envelope.schema.json')); const validate = ajv.compile(read('billing.cancel-charge.v1.schema.json'));
  return value => validate(value) === true;
}
/** The caller verifies the OS signature; the command is persisted before broker acknowledgement. */
export class CancelChargeCommandConsumer {
  constructor(private readonly db: PrismaClient, private readonly validate: (value: unknown) => boolean) {}
  async process(message: ServiceBusReceivedMessage, receiver: Receiver): Promise<void> {
    const body: unknown = message.body;
    if (!this.validate(body) || !body || typeof body !== 'object' || !('messageId' in body) || body.messageId !== message.messageId || (message.subject && message.subject !== 'billing.cancel-charge.v1')) {
      await receiver.deadLetterMessage(message, { deadLetterReason: 'InvalidContract', deadLetterErrorDescription: 'Comando inválido' }); return;
    }
    const event = body as Envelope; const encoded = JSON.stringify(event);
    try {
      await this.db.$transaction(async tx => {
        await tx.$executeRaw`INSERT INTO "Inbox" ("consumer", "messageId", "operationId", "type", "payload", "status") VALUES (${staging}, ${event.messageId}, ${event.operationId}, ${event.type}, ${encoded}::jsonb, 'PENDING') ON CONFLICT DO NOTHING`;
        const rows = await tx.$queryRaw<Array<{ matches: boolean }>>`SELECT ("operationId" = ${event.operationId} AND "type" = ${event.type} AND "payload" = ${encoded}::jsonb) AS "matches" FROM "Inbox" WHERE "consumer" = ${staging} AND "messageId" = ${event.messageId}`;
        if (!rows[0]?.matches) throw new Error('Mensagem divergente');
      });
    } catch { await receiver.abandonMessage(message); return; }
    await receiver.completeMessage(message);
  }
}
/** A restart re-queries uncertain attempts; it never resends the provider mutation. */
export class CancelChargeCommandProcessor {
  private cursor = '';
  constructor(private readonly db: PrismaClient, private readonly prepare: PrepareChargeCancellation, private readonly cancel: CancelChargeService, private readonly validate: (value: unknown) => boolean) {}
  async processOne(): Promise<'EMPTY' | 'PENDING' | 'CANCELED' | 'RECONCILIACAO_NECESSARIA'> {
    const find = (cursor: string) => this.db.$queryRaw<Array<{ messageId: string; payload: unknown }>>`SELECT s."messageId", s."payload" FROM "Inbox" s WHERE s."consumer"=${staging} AND s."status" IN ('PENDING','RECONCILIACAO_NECESSARIA') AND s."messageId" > ${cursor} AND EXISTS (SELECT 1 FROM "Inbox" e WHERE e."consumer"='billing.compensation-evidence' AND e."messageId"=s."payload"->'data'->>'cancelEventId' AND e."status"='APPLIED') ORDER BY s."messageId" LIMIT 1`;
    let rows = await find(this.cursor); if (!rows.length && this.cursor) { this.cursor = ''; rows = await find(this.cursor); }
    const row = rows[0]; if (!row) return 'EMPTY'; this.cursor = row.messageId;
    if (!this.validate(row.payload)) throw new Error('Comando persistido inválido');
    const event = row.payload as Envelope;
    const input: CancelChargeInput = { messageId: event.messageId, operationId: event.operationId, correlationId: event.correlationId, osId: event.osId, sagaId: event.sagaId, filialId: event.filialId, ...(event.traceparent ? { traceparent: event.traceparent } : {}), ...(event.tracestate ? { tracestate: event.tracestate } : {}), ...event.data };
    try {
      await this.prepare.execute(input);
      const result = await this.cancel.submit(input.messageId);
      const outcome = result === 'IN_FLIGHT' || result === 'RECONCILIACAO_NECESSARIA' ? await this.cancel.reconcile(input.messageId) : result;
      await this.db.inbox.updateMany({ where: { consumer: staging, messageId: input.messageId, status: { in: ['PENDING', 'RECONCILIACAO_NECESSARIA'] } }, data: { status: outcome, ...(outcome === 'CANCELED' ? { appliedAt: new Date() } : {}) } });
      return outcome;
    } catch { return 'PENDING'; }
  }
}
