import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { PrismaClient } from '@prisma/client';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { MessageVerifier } from './message-signature';

type Receiver = Pick<ServiceBusReceiver, 'completeMessage' | 'abandonMessage' | 'deadLetterMessage'>;
type Evidence = { messageId: string; operationId: string; type: string; [key: string]: unknown };
export function evidenceValidator(directory: string): (event: unknown) => boolean {
  const ajv = new Ajv({ allErrors: true }); addFormats(ajv);
  const read = (filename: string): object => JSON.parse(readFileSync(resolve(directory, filename), 'utf8')) as object;
  ajv.addSchema(read('envelope.schema.json'));
  const validate = ajv.compile(read('execution.work-cancelled.v1.schema.json'));
  return (event) => validate(event) === true;
}
/** Stores only verified evidence; presence alone never triggers a refund. */
export class CompensationEvidenceConsumer {
  constructor(private readonly db: PrismaClient, private readonly verifier: MessageVerifier, private readonly validate: (event: unknown) => boolean) {}
  async process(message: ServiceBusReceivedMessage, receiver: Receiver): Promise<void> {
    const body: unknown = message.body;
    if (!this.verifier.verify(body, message.applicationProperties?.signature) || !this.validate(body) || !body || typeof body !== 'object' || !('messageId' in body) || body.messageId !== message.messageId || (message.subject && message.subject !== 'execution.work-cancelled.v1')) {
      await receiver.deadLetterMessage(message, { deadLetterReason: 'InvalidEvidence', deadLetterErrorDescription: 'Evidência inválida ou não autenticada' }); return;
    }
    const event = body as Evidence; const encoded = JSON.stringify(event); const consumer = 'billing.compensation-evidence';
    try {
      await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO "Inbox" ("consumer", "messageId", "operationId", "type", "payload", "status", "appliedAt") VALUES (${consumer}, ${event.messageId}, ${event.operationId}, ${event.type}, ${encoded}::jsonb, 'APPLIED', NOW()) ON CONFLICT DO NOTHING`;
        const rows = await tx.$queryRaw<Array<{ matches: boolean }>>`SELECT ("operationId" = ${event.operationId} AND "type" = ${event.type} AND "payload" = ${encoded}::jsonb AND "status" = 'APPLIED') AS "matches" FROM "Inbox" WHERE "consumer" = ${consumer} AND "messageId" = ${event.messageId}`;
        if (!rows[0]?.matches) throw new Error('Evidência reutilizada com conteúdo diferente');
      });
    } catch { await receiver.abandonMessage(message); return; }
    await receiver.completeMessage(message);
  }
}
