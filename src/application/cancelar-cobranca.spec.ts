import { PrismaClient } from '@prisma/client';
import { ChargeCancellationBlockedError, PrepareChargeCancellation } from './cancelar-cobranca';

describe('preparação do cancelamento de cobrança', () => {
  const input = { messageId: 'm1', operationId: 'op1', correlationId: 'c1', osId: 'os1', sagaId: 's1', filialId: 'f1', chargeId: 'charge1', reservationId: 'res1', cancelOperationId: 'cancel1', cancelEventId: 'event1' };
  const cancelled = { messageId: input.cancelEventId, type: 'execution.work-cancelled.v1', producer: 'soat-execution-service', operationId: input.cancelOperationId, osId: input.osId, sagaId: input.sagaId, filialId: input.filialId, data: { outcome: 'CANCELLED' } };
  const charge = { id: input.chargeId, osId: input.osId, status: 'CREATED', providerOrderId: 'ORD1', currency: 'BRL', payments: [], quote: { sagaId: input.sagaId, filialId: input.filialId }, attempts: [{ status: 'CREATED', result: { reservationId: input.reservationId, sagaId: input.sagaId, filialId: input.filialId } }] };
  const tx = { $queryRaw: jest.fn(), commandOperation: { findUnique: jest.fn(), create: jest.fn() }, inbox: { findUnique: jest.fn(), create: jest.fn() }, charge: { findUnique: jest.fn(), update: jest.fn() } };
  const db = { $transaction: jest.fn(async (fn: (value: typeof tx) => Promise<void>) => fn(tx)) };
  const prepare = new PrepareChargeCancellation(db as unknown as PrismaClient);
  const withEvidence = (payload: unknown) => tx.inbox.findUnique.mockImplementation(async (query: { where: { consumer_messageId: { consumer: string } } }) => query.where.consumer_messageId.consumer === 'billing.compensation-evidence' ? { status: 'APPLIED', payload } : null);
  beforeEach(() => { jest.clearAllMocks(); tx.commandOperation.findUnique.mockResolvedValue(null); tx.charge.findUnique.mockResolvedValue(charge); withEvidence(cancelled); });
  it('registra intenção somente com cancelamento sem início', async () => {
    await prepare.execute(input);
    expect(tx.commandOperation.create).toHaveBeenCalledTimes(1);
    expect(tx.charge.update).toHaveBeenCalledWith({ where: { id: input.chargeId }, data: { status: 'CANCELLING' } });
  });
  it('recusa falha de execução: cobrança só é cancelada com work-cancelled CANCELLED', async () => {
    withEvidence({ ...cancelled, type: 'execution.work-failed.v1', data: { executionId: 'e1', reservationId: input.reservationId, reason: 'REPARO_INVIAVEL' } });
    await expect(prepare.execute(input)).rejects.toMatchObject({ reasonCode: 'CANCEL_EVIDENCE_MISMATCH' });
    await expect(prepare.execute(input)).rejects.toBeInstanceOf(ChargeCancellationBlockedError);
    expect(tx.charge.findUnique).not.toHaveBeenCalled(); expect(tx.commandOperation.create).not.toHaveBeenCalled();
  });
  it('recusa cancelamento cujo trabalho já começou', async () => {
    withEvidence({ ...cancelled, data: { outcome: 'ALREADY_STARTED' } });
    await expect(prepare.execute(input)).rejects.toMatchObject({ reasonCode: 'CANCEL_EVIDENCE_MISMATCH' });
    expect(tx.charge.update).not.toHaveBeenCalled();
  });
});
