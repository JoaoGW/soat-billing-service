import { PrismaClient } from '@prisma/client';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { MessageVerifier } from './message-signature';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CompensationEvidenceConsumer, evidenceValidator, isCompensationEvidenceType } from './compensation-evidence';
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
  it('persiste falha de execução na mesma inbox de evidência', async () => {
    const failed = { messageId: 'f', operationId: 'o', type: 'execution.work-failed.v1' };
    await consumer.process({ messageId: 'f', subject: failed.type, body: failed, applicationProperties: { signature: 'sig' } } as unknown as ServiceBusReceivedMessage, receiver as unknown as ServiceBusReceiver);
    expect(receiver.completeMessage).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw.mock.calls[0]).toEqual(expect.arrayContaining(['billing.compensation-evidence', 'f', 'o', 'execution.work-failed.v1']));
  });
  it('rejeita subject diferente do tipo do envelope', async () => {
    await consumer.process({ ...message, subject: 'execution.work-failed.v1' } as unknown as ServiceBusReceivedMessage, receiver as unknown as ServiceBusReceiver);
    expect(receiver.deadLetterMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ deadLetterReason: 'InvalidEvidence' }));
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
describe('contratos de evidência de compensação', () => {
  const dir = resolve(process.cwd(), 'docs/contracts/messages');
  const example = (type: string) => JSON.parse(readFileSync(resolve(dir, `examples/${type}.json`), 'utf8')) as Record<string, unknown>;
  const validate = evidenceValidator(dir);
  it('aceita cancelamento e falha de execução conforme o schema de cada tipo', () => {
    expect(validate(example('execution.work-cancelled.v1'))).toBe(true);
    expect(validate(example('execution.work-failed.v1'))).toBe(true);
  });
  it('recusa tipos alheios, dados trocados e entradas que não são envelope', () => {
    const failed = example('execution.work-failed.v1');
    expect(validate({ ...failed, data: example('execution.work-cancelled.v1').data })).toBe(false);
    expect(validate({ ...failed, producer: 'soat-os-service' })).toBe(false);
    expect(validate({ ...failed, type: 'execution.work-started.v1' })).toBe(false);
    expect(validate(null)).toBe(false); expect(validate('execution.work-failed.v1')).toBe(false);
    expect(isCompensationEvidenceType('execution.work-failed.v1')).toBe(true);
    expect(isCompensationEvidenceType('execution.work-started.v1')).toBe(false); expect(isCompensationEvidenceType(undefined)).toBe(false);
  });
});
