import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { ChargeCommandConsumer, createChargeCommandValidator } from './charge-consumer';

describe('ChargeCommandConsumer', () => {
  const dir = resolve(process.cwd(), 'docs/contracts/messages');
  const validate = createChargeCommandValidator(dir);
  const fixture = JSON.parse(readFileSync(resolve(dir, 'examples/billing.create-charge.v1.json'), 'utf8')) as { messageId: string; type: string; operationId: string; data: { chargeId: string } };
  const message = { body: fixture, messageId: fixture.messageId, subject: fixture.type } as ServiceBusReceivedMessage;
  const receiver = { completeMessage: jest.fn(), abandonMessage: jest.fn(), deadLetterMessage: jest.fn() };
  const broker = receiver as unknown as ServiceBusReceiver;
  const prepare = { execute: jest.fn() }; const submit = { execute: jest.fn() };
  const consumer = new ChargeCommandConsumer(prepare, submit, validate);
  beforeEach(() => { jest.resetAllMocks(); submit.execute.mockResolvedValue('CREATED'); });
  it('confirma após intenção e evento de cobrança persistidos', async () => {
    await consumer.process(message, broker);
    expect(prepare.execute).toHaveBeenCalledWith(expect.objectContaining({ operationId: fixture.operationId, chargeId: fixture.data.chargeId }));
    expect(submit.execute).toHaveBeenCalledWith(fixture.operationId);
    expect(receiver.completeMessage).toHaveBeenCalledWith(message);
  });
  it('mantém reentrega em caso de reconciliação ou falha', async () => {
    submit.execute.mockResolvedValueOnce('RECONCILIACAO_NECESSARIA');
    await consumer.process(message, broker);
    prepare.execute.mockRejectedValueOnce(new Error('db offline'));
    await consumer.process(message, broker);
    expect(receiver.abandonMessage).toHaveBeenCalledTimes(2);
    expect(receiver.completeMessage).not.toHaveBeenCalled();
  });
  it('confirma falha de prazo somente após evento durável', async () => {
    submit.execute.mockResolvedValueOnce('EXPIRED');
    await consumer.process(message, broker);
    expect(receiver.completeMessage).toHaveBeenCalledWith(message);
  });
  it('encaminha contrato inválido à DLQ', async () => {
    await consumer.process({ ...message, messageId: 'other' }, broker);
    await consumer.process({ ...message, body: { ...fixture, type: 'outro' } }, broker);
    expect(receiver.deadLetterMessage).toHaveBeenCalledTimes(2);
    expect(prepare.execute).not.toHaveBeenCalled();
  });
  it('propaga erro de confirmação para reentrega idempotente', async () => {
    receiver.completeMessage.mockRejectedValueOnce(new Error('lock'));
    await expect(consumer.process(message, broker)).rejects.toThrow('lock');
    expect(receiver.abandonMessage).not.toHaveBeenCalled();
  });
});
