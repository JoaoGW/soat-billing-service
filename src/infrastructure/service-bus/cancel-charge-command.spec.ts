import { PrismaClient } from '@prisma/client';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { CancelChargeCommandConsumer, CancelChargeCommandProcessor, cancelChargeValidator } from './cancel-charge-command';
import { CancelChargeService, PrepareChargeCancellation } from '../../application/cancelar-cobranca';

describe('comando de cancelamento de cobrança', () => {
  const tx = { $executeRaw: jest.fn(), $queryRaw: jest.fn() };
  const db = { $transaction: jest.fn(async (fn: (x: typeof tx) => Promise<void>) => fn(tx)), $queryRaw: jest.fn(), inbox: { updateMany: jest.fn() } };
  const validate = jest.fn(); const receiver = { completeMessage: jest.fn(), abandonMessage: jest.fn(), deadLetterMessage: jest.fn() };
  const body = { messageId: 'm', operationId: 'op', correlationId: 'c', osId: 'os', sagaId: 's', filialId: 'f', type: 'billing.cancel-charge.v1', data: { chargeId: 'charge', reservationId: 'reserve', cancelOperationId: 'cancel', cancelEventId: 'e' } };
  const msg = { body, messageId: 'm', subject: body.type } as unknown as ServiceBusReceivedMessage;
  const prepare = { execute: jest.fn() }; const cancel = { submit: jest.fn(), reconcile: jest.fn() };
  const consumer = new CancelChargeCommandConsumer(db as unknown as PrismaClient, validate);
  const processor = new CancelChargeCommandProcessor(db as unknown as PrismaClient, prepare as unknown as PrepareChargeCancellation, cancel as unknown as CancelChargeService, validate);
  beforeEach(() => { jest.resetAllMocks(); db.$transaction.mockImplementation(async (fn: (x: typeof tx) => Promise<void>) => fn(tx)); validate.mockReturnValue(true); tx.$queryRaw.mockResolvedValue([{ matches: true }]); db.$queryRaw.mockResolvedValue([{ messageId: 'm', payload: body }]); prepare.execute.mockResolvedValue(undefined); cancel.submit.mockResolvedValue('CANCELED'); cancel.reconcile.mockResolvedValue('CANCELED'); });
  it('valida contrato e produtor', () => {
    const validator = cancelChargeValidator(resolve(process.cwd(), 'docs/contracts/messages'));
    const fixture = JSON.parse(readFileSync(resolve(process.cwd(), 'docs/contracts/messages/examples/billing.cancel-charge.v1.json'), 'utf8')) as Record<string, unknown>;
    expect(validator(fixture)).toBe(true); expect(validator({ ...fixture, producer: 'other' })).toBe(false);
  });
  it('persiste antes de ACK e recusa mensagem inválida', async () => {
    await consumer.process(msg, receiver as unknown as ServiceBusReceiver); expect(receiver.completeMessage).toHaveBeenCalledTimes(1);
    validate.mockReturnValue(false); await consumer.process(msg, receiver as unknown as ServiceBusReceiver); expect(receiver.deadLetterMessage).toHaveBeenCalledTimes(1);
  });
  it('não confirma colisão de conteúdo ou falha de banco', async () => {
    tx.$queryRaw.mockResolvedValue([{ matches: false }]); await consumer.process(msg, receiver as unknown as ServiceBusReceiver);
    expect(receiver.abandonMessage).toHaveBeenCalledTimes(1); expect(receiver.completeMessage).not.toHaveBeenCalled();
  });
  it('processa confirmação e não acessa provedor quando preparação falha', async () => {
    prepare.execute.mockRejectedValueOnce(new Error('evidência ausente')); expect(await processor.processOne()).toBe('PENDING'); expect(cancel.submit).not.toHaveBeenCalled();
    expect(await processor.processOne()).toBe('CANCELED'); expect(cancel.submit).toHaveBeenCalledTimes(1);
  });
  it.each(['IN_FLIGHT', 'RECONCILIACAO_NECESSARIA'])('reconcilia %s sem reenviar mutação', async state => {
    cancel.submit.mockResolvedValue(state); cancel.reconcile.mockResolvedValue('RECONCILIACAO_NECESSARIA');
    expect(await processor.processOne()).toBe('RECONCILIACAO_NECESSARIA'); expect(cancel.reconcile).toHaveBeenCalledWith('m');
  });
  it('percorre fila vazia e rejeita comando persistido inválido', async () => {
    db.$queryRaw.mockResolvedValue([]); expect(await processor.processOne()).toBe('EMPTY');
    db.$queryRaw.mockResolvedValue([{ messageId: 'm', payload: body }]); validate.mockReturnValue(false); await expect(processor.processOne()).rejects.toThrow('inválido');
  });
});
