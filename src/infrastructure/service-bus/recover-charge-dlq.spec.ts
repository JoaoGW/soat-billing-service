import { PrismaClient } from '@prisma/client';
import { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';
import { chargeFingerprint, PrepareCharge } from '../../application/preparar-cobranca';
import { RecoverBillingChargeDlq } from './recover-charge-dlq';

describe('recuperação de cobrança já comprovada na DLQ', () => {
  const command: PrepareCharge = { messageId: 'msg', operationId: 'op', correlationId: 'corr', osId: 'os', sagaId: 'saga', filialId: 'branch', quoteId: 'quote', quoteVersion: 1, chargeId: 'charge', clientId: 'client', totalInCents: 500, currency: 'BRL', reservationId: 'reservation', externalPosId: 'pos', expiresAt: '2030-01-01T00:15:00Z' };
  const body = { messageId: command.messageId, operationId: command.operationId, osId: command.osId, sagaId: command.sagaId, filialId: command.filialId, correlationId: command.correlationId, type: 'billing.create-charge.v1', data: { quoteId: command.quoteId, quoteVersion: command.quoteVersion, chargeId: command.chargeId, clientId: command.clientId, totalInCents: command.totalInCents, currency: command.currency, reservationId: command.reservationId, externalPosId: command.externalPosId, expiresAt: command.expiresAt } };
  const message = { messageId: 'msg', subject: body.type, body, applicationProperties: { signature: 'signed' } } as unknown as ServiceBusReceivedMessage;
  const fp = chargeFingerprint(command), result = { fingerprint: fp, messageId: 'msg' };
  const charge = { id: 'charge', quoteId: 'quote', osId: 'os', amountInCents: 500, currency: 'BRL', externalReference: 'charge', expiresAt: new Date(command.expiresAt), providerOrderId: 'order' };
  const attempt = { chargeId: 'charge', status: 'CREATED', result, charge };
  const inbox = { status: 'APPLIED', operationId: 'op', payload: result };
  const event = { messageId: 'event', type: 'billing.charge-created.v1', operationId: 'op', causationId: 'msg', osId: 'os', sagaId: 'saga', filialId: 'branch', data: { chargeId: 'charge', quoteId: 'quote', quoteVersion: 1, reservationId: 'reservation', providerOrderId: 'order', externalReference: 'charge', expiresAt: command.expiresAt, totalInCents: 500, currency: 'BRL', clientId: 'client' } };
  const tx = { $queryRaw: jest.fn(), chargeAttempt: { findUnique: jest.fn() }, inbox: { findUnique: jest.fn() }, outbox: { findMany: jest.fn() }, billingRecoveryAudit: { create: jest.fn() } };
  const db = { $transaction: jest.fn((fn: (value: typeof tx) => Promise<void>) => fn(tx)) };
  const verifier = { verify: jest.fn() }, validate = jest.fn(), validateEvent = jest.fn(), receiver = { completeMessage: jest.fn() };
  const service = new RecoverBillingChargeDlq(db as unknown as PrismaClient, verifier, validate, validateEvent);
  const input = { messageId: 'msg', actor: 'operator', reasonCode: 'BROKER_RESTORED' };
  beforeEach(() => { jest.clearAllMocks(); verifier.verify.mockReturnValue(true); validate.mockReturnValue(true); validateEvent.mockReturnValue(true); tx.chargeAttempt.findUnique.mockResolvedValue(attempt); tx.inbox.findUnique.mockResolvedValue(inbox); tx.outbox.findMany.mockResolvedValue([{ messageId: 'event', payload: event }]); });
  it('confirma somente após conferir resultado, evento e auditoria', async () => {
    await expect(service.execute(message, receiver as unknown as ServiceBusReceiver, input)).resolves.toBe('VERIFIED');
    expect(tx.billingRecoveryAudit.create).toHaveBeenCalledTimes(1); expect(receiver.completeMessage).toHaveBeenCalledTimes(1);
  });
  it('não deixa campos extras no corpo substituir IDs do envelope', async () => {
    const extra = { ...message, body: { ...body, data: { ...body.data, osId: 'other', operationId: 'other' } } };
    await expect(service.execute(extra, receiver as never, input)).resolves.toBe('VERIFIED');
    expect(tx.chargeAttempt.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { operationId: 'op' } }));
  });
  it.each(['INTENT_RECORDED', 'IN_FLIGHT', 'RECONCILIACAO_NECESSARIA'])('mantém %s na DLQ sem presumir resultado', async status => {
    tx.chargeAttempt.findUnique.mockResolvedValue({ ...attempt, status });
    await expect(service.execute(message, receiver as never, input)).rejects.toThrow('não comprovado');
    expect(receiver.completeMessage).not.toHaveBeenCalled(); expect(tx.billingRecoveryAudit.create).not.toHaveBeenCalled();
  });
  it('aceita expiração somente com evento correspondente', async () => {
    tx.chargeAttempt.findUnique.mockResolvedValue({ ...attempt, status: 'EXPIRED', charge: { ...charge, status: 'EXPIRED', providerOrderId: null } });
    tx.outbox.findMany.mockResolvedValue([{ messageId: 'event', payload: { ...event, type: 'billing.charge-failed.v1', data: { chargeId: 'charge', quoteId: 'quote', quoteVersion: 1, reservationId: 'reservation', reasonCode: 'EXPIRED' } } }]);
    await expect(service.execute(message, receiver as never, input)).resolves.toBe('VERIFIED');
  });
  it('recusa expiração quando há ID do provedor ou estado financeiro divergente', async () => {
    tx.chargeAttempt.findUnique.mockResolvedValueOnce({ ...attempt, status: 'EXPIRED', charge: { ...charge, status: 'EXPIRED' } }).mockResolvedValueOnce({ ...attempt, status: 'EXPIRED', charge: { ...charge, status: 'PAID', providerOrderId: null } });
    await expect(service.execute(message, receiver as never, input)).rejects.toThrow('não comprovado');
    await expect(service.execute(message, receiver as never, input)).rejects.toThrow('não comprovado');
    expect(receiver.completeMessage).not.toHaveBeenCalled();
  });
  it('recusa assinatura, fingerprint, evento ausente e evento duplicado', async () => {
    verifier.verify.mockReturnValueOnce(false); await expect(service.execute(message, receiver as never, input)).rejects.toThrow();
    tx.inbox.findUnique.mockResolvedValueOnce({ ...inbox, payload: { fingerprint: 'other' } }); await expect(service.execute(message, receiver as never, input)).rejects.toThrow('não comprovado');
    tx.outbox.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ messageId: 'event', payload: event }, { messageId: 'event', payload: event }]);
    await expect(service.execute(message, receiver as never, input)).rejects.toThrow('Evento financeiro');
    await expect(service.execute(message, receiver as never, input)).rejects.toThrow('Evento financeiro');
    expect(receiver.completeMessage).not.toHaveBeenCalled();
  });
  it('recusa mudança no valor, evento divergente e falha de auditoria', async () => {
    tx.chargeAttempt.findUnique.mockResolvedValueOnce({ ...attempt, charge: { ...charge, amountInCents: 501 } });
    await expect(service.execute(message, receiver as never, input)).rejects.toThrow('não comprovado');
    tx.outbox.findMany.mockResolvedValueOnce([{ messageId: 'event', payload: { ...event, data: { ...event.data, providerOrderId: 'other' } } }]);
    await expect(service.execute(message, receiver as never, input)).rejects.toThrow('Evento financeiro');
    tx.billingRecoveryAudit.create.mockRejectedValueOnce(new Error('audit offline'));
    await expect(service.execute(message, receiver as never, input)).rejects.toThrow('audit offline');
    expect(receiver.completeMessage).not.toHaveBeenCalled();
  });
});
