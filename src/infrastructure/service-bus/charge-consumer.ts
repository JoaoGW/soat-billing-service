import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { PrepareCharge } from '../../application/preparar-cobranca';

type Receiver = Pick<ServiceBusReceiver, 'completeMessage' | 'abandonMessage' | 'deadLetterMessage'>;
type Prepare = { execute(input: PrepareCharge): Promise<unknown> };
type Submit = { execute(operationId: string): Promise<string> };
type Envelope = Pick<PrepareCharge, 'messageId' | 'operationId' | 'correlationId' | 'osId' | 'sagaId' | 'filialId' | 'traceparent' | 'tracestate'> & { data: Omit<PrepareCharge, 'messageId' | 'operationId' | 'correlationId' | 'osId' | 'sagaId' | 'filialId' | 'traceparent' | 'tracestate'> };

export function createChargeCommandValidator(directory: string): (value: unknown) => boolean {
  const ajv = new Ajv({ allErrors: true }); addFormats(ajv);
  const read = (name: string): object => JSON.parse(readFileSync(resolve(directory, name), 'utf8')) as object;
  ajv.addSchema(read('envelope.schema.json'));
  const validate = ajv.compile(read('billing.create-charge.v1.schema.json'));
  return (value) => validate(value) === true;
}

export class ChargeCommandConsumer {
  constructor(private readonly prepare: Prepare, private readonly submit: Submit, private readonly validate: (value: unknown) => boolean) {}
  async process(message: ServiceBusReceivedMessage, receiver: Receiver): Promise<void> {
    const body: unknown = message.body;
    if (!this.validate(body) || !body || typeof body !== 'object' || !('messageId' in body) || body.messageId !== message.messageId || (message.subject && message.subject !== 'billing.create-charge.v1')) {
      await receiver.deadLetterMessage(message, { deadLetterReason: 'InvalidContract', deadLetterErrorDescription: 'Mensagem inválida ou versão não suportada' });
      return;
    }
    const event = body as Envelope; const d = event.data;
    let outcome: string;
    try {
      await this.prepare.execute({ messageId: event.messageId, operationId: event.operationId, correlationId: event.correlationId, osId: event.osId, sagaId: event.sagaId, filialId: event.filialId, quoteId: d.quoteId, quoteVersion: d.quoteVersion, chargeId: d.chargeId, clientId: d.clientId, totalInCents: d.totalInCents, currency: d.currency, reservationId: d.reservationId, externalPosId: d.externalPosId, expiresAt: d.expiresAt, ...(event.traceparent ? { traceparent: event.traceparent } : {}), ...(event.tracestate ? { tracestate: event.tracestate } : {}) });
      outcome = await this.submit.execute(event.operationId);
    } catch {
      await receiver.abandonMessage(message); return;
    }
    if (outcome !== 'CREATED' && outcome !== 'EXPIRED') { await receiver.abandonMessage(message); return; }
    await receiver.completeMessage(message);
  }
}
