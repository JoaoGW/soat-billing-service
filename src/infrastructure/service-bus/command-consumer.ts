import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { GenerateQuoteCommand } from '../../application/gerar-orcamento';

type QuoteCommandHandler = { execute(command: GenerateQuoteCommand): Promise<unknown> };
type Receiver = Pick<ServiceBusReceiver, 'completeMessage' | 'abandonMessage' | 'deadLetterMessage'>;

export function createQuoteCommandValidator(directory: string): (value: unknown) => boolean {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const read = (name: string): object => JSON.parse(readFileSync(resolve(directory, name), 'utf8')) as object;
  ajv.addSchema(read('envelope.schema.json'));
  const validate = ajv.compile(read('billing.generate-quote.v1.schema.json'));
  return (value) => validate(value) === true;
}

export class ServiceBusCommandConsumer {
  constructor(private readonly handler: QuoteCommandHandler, private readonly validate: (value: unknown) => boolean) {}

  async process(message: ServiceBusReceivedMessage, receiver: Receiver): Promise<void> {
    const body: unknown = message.body;
    if (!this.validate(body) || typeof body !== 'object' || body === null || !('messageId' in body) ||
        body.messageId !== message.messageId || (message.subject && message.subject !== 'billing.generate-quote.v1')) {
      await receiver.deadLetterMessage(message, { deadLetterReason: 'InvalidContract', deadLetterErrorDescription: 'Mensagem inválida ou versão não suportada' });
      return;
    }
    try {
      await this.handler.execute(body as GenerateQuoteCommand);
    } catch {
      // Broker delivery limits determine DLQ; never acknowledge a failed commit.
      await receiver.abandonMessage(message);
      return;
    }
    // Do not abandon after a complete failure: the broker may already have
    // accepted the acknowledgement; lock expiry causes safe inbox redelivery.
    await receiver.completeMessage(message);
  }
}
