import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { createQuoteCommandValidator, ServiceBusCommandConsumer } from './command-consumer';

describe('ServiceBusCommandConsumer', () => {
  const validator = createQuoteCommandValidator(resolve(process.cwd(), 'docs/contracts/messages'));
  const fixture = JSON.parse(readFileSync(resolve(process.cwd(), 'docs/contracts/messages/examples/billing.generate-quote.v1.json'), 'utf8')) as { messageId: string; type: string };
  const message = { body: fixture, messageId: fixture.messageId, subject: fixture.type } as ServiceBusReceivedMessage;
  const handler = { execute: jest.fn() };
  const receiver = { completeMessage: jest.fn(), abandonMessage: jest.fn(), deadLetterMessage: jest.fn() };
  const consumer = new ServiceBusCommandConsumer(handler, validator);
  beforeEach(() => jest.resetAllMocks());

  it('confirma somente depois do handler persistir', async () => {
    await consumer.process(message, receiver as unknown as ServiceBusReceiver);
    expect(handler.execute).toHaveBeenCalledWith(fixture);
    expect(receiver.completeMessage).toHaveBeenCalledWith(message);
    expect(receiver.abandonMessage).not.toHaveBeenCalled();
  });
  it('encaminha contrato inválido ou ID incompatível para DLQ', async () => {
    await consumer.process({ ...message, messageId: 'outro' }, receiver as unknown as ServiceBusReceiver);
    await consumer.process({ ...message, body: { ...fixture, type: 'desconhecido' } }, receiver as unknown as ServiceBusReceiver);
    expect(receiver.deadLetterMessage).toHaveBeenCalledTimes(2);
    expect(handler.execute).not.toHaveBeenCalled();
  });
  it('rejeita datas inválidas no contrato', async () => {
    const body = JSON.parse(readFileSync(resolve(process.cwd(), 'docs/contracts/messages/examples/billing.generate-quote.v1.json'), 'utf8')) as { data: { expiresAt: string } };
    body.data.expiresAt = 'data-inválida';
    await consumer.process({ ...message, body }, receiver as unknown as ServiceBusReceiver);
    expect(receiver.deadLetterMessage).toHaveBeenCalledTimes(1);
  });
  it('abandona a mensagem quando o commit falha', async () => {
    handler.execute.mockRejectedValue(new Error('banco indisponível'));
    await consumer.process(message, receiver as unknown as ServiceBusReceiver);
    expect(receiver.abandonMessage).toHaveBeenCalledWith(message);
    expect(receiver.completeMessage).not.toHaveBeenCalled();
  });
  it('propaga falha de confirmação sem repetir efeito local', async () => {
    receiver.completeMessage.mockRejectedValue(new Error('lock expirado'));
    await expect(consumer.process(message, receiver as unknown as ServiceBusReceiver)).rejects.toThrow('lock expirado');
    expect(handler.execute).toHaveBeenCalledTimes(1);
    expect(receiver.abandonMessage).not.toHaveBeenCalled();
  });
});
