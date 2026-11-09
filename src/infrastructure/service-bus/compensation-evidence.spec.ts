import { PrismaClient } from '@prisma/client';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { MessageVerifier } from './message-signature';
import { CompensationEvidenceConsumer } from './compensation-evidence';
describe('evidência de compensação', () => {
  const tx = { $executeRaw: jest.fn(), $queryRaw: jest.fn() };
  const db = { $transaction: jest.fn(async (fn: (value: typeof tx) => Promise<void>) => fn(tx)) };
  const verifier = { verify: jest.fn() }; const validate = jest.fn();
  const receiver = { completeMessage: jest.fn(), abandonMessage: jest.fn(), deadLetterMessage: jest.fn() };
  const consumer = new CompensationEvidenceConsumer(db as unknown as PrismaClient, verifier as unknown as MessageVerifier, validate);
  const body = { messageId: 'm', operationId: 'o', type: 'execution.work-cancelled.v1' };
  const message = { messageId: 'm', body, applicationProperties: { signature: 'sig' } } as unknown as ServiceBusReceivedMessage;
  beforeEach(() => { jest.clearAllMocks(); verifier.verify.mockReturnValue(true); validate.mockReturnValue(true); tx.$queryRaw.mockResolvedValue([{ matches: true }]); });
  it('rejeita assinatura inválida sem consultar banco', async () => {
    verifier.verify.mockReturnValue(false); await consumer.process(message, receiver as unknown as ServiceBusReceiver);
    expect(receiver.deadLetterMessage).toHaveBeenCalledTimes(1); expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('confirma depois de persistir e abandona evidência divergente', async () => {
    await consumer.process(message, receiver as unknown as ServiceBusReceiver); expect(receiver.completeMessage).toHaveBeenCalledTimes(1);
    tx.$queryRaw.mockResolvedValue([{ matches: false }]); await consumer.process(message, receiver as unknown as ServiceBusReceiver); expect(receiver.abandonMessage).toHaveBeenCalledTimes(1);
  });
});
