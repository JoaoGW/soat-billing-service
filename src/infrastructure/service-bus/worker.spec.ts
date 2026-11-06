import { generateKeyPairSync } from 'node:crypto';
import { MessageSigner } from './message-signature';
import { WorkloadIdentityCredential } from '@azure/identity';
import { ServiceBusClient } from '@azure/service-bus';
import { PrismaClient } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { OutboxDispatcher } from '../../application/publicar-outbox';
import { BillingMessageWorker } from './worker';
import { RefundCommandProcessor } from './refund-command';
import { ReconcileRefundService } from '../../application/reconciliar-reembolso';

jest.mock('@azure/identity');
jest.mock('@azure/service-bus');
jest.mock('@prisma/client');
jest.mock('../../application/publicar-outbox');

describe('BillingMessageWorker', () => {
  const keys = generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const signer = new MessageSigner(privateKey);
  const signed = (body: object) => ({ subject: 'billing.create-charge.v1', body, applicationProperties: { signature: signer.sign(body) } });
  const originalEnv = process.env;
  const closeSubscription = jest.fn().mockResolvedValue(undefined);
  const receiver = { subscribe: jest.fn(), close: jest.fn().mockResolvedValue(undefined), completeMessage: jest.fn().mockResolvedValue(undefined), abandonMessage: jest.fn().mockResolvedValue(undefined), deadLetterMessage: jest.fn().mockResolvedValue(undefined) };
  const sender = { close: jest.fn().mockResolvedValue(undefined) };
  const client = { createSender: jest.fn(), createReceiver: jest.fn(), close: jest.fn().mockResolvedValue(undefined) };
  const prisma = { $disconnect: jest.fn().mockResolvedValue(undefined), $queryRaw: jest.fn(), inbox: { updateMany: jest.fn() } };
  const dispatcher = { dispatchOne: jest.fn().mockResolvedValue('EMPTY') };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, ENABLE_SERVICE_BUS_WORKER: 'false', ENABLE_MERCADO_PAGO_COMMANDS: 'false', ENABLE_MERCADO_PAGO_REFUND_RECONCILIATION: 'false', ENABLE_MERCADO_PAGO_REFUND_COMMANDS: 'false', ENABLE_BILLING_COMPENSATION_EVIDENCE: 'false', BILLING_MESSAGE_PRIVATE_KEY: privateKey, OS_MESSAGE_PUBLIC_KEY: publicKey };
    delete process.env.MERCADO_PAGO_ACCESS_TOKEN;
    receiver.subscribe.mockReturnValue({ close: closeSubscription });
    client.createSender.mockReturnValue(sender);
    client.createReceiver.mockReturnValue(receiver);
    jest.mocked(ServiceBusClient).mockImplementation(() => client as unknown as ServiceBusClient);
    jest.mocked(PrismaClient).mockImplementation(() => prisma as unknown as PrismaClient);
    jest.mocked(OutboxDispatcher).mockImplementation(() => dispatcher as unknown as OutboxDispatcher);
  });
  afterEach(() => { process.env = originalEnv; });

  it('não inicializa conexões por padrão', async () => {
    const worker = new BillingMessageWorker();
    worker.onModuleInit();
    await worker.onApplicationShutdown();
    expect(ServiceBusClient).not.toHaveBeenCalled();
    expect(PrismaClient).not.toHaveBeenCalled();
  });

  it('falha sem configuração completa quando habilitado', () => {
    process.env.ENABLE_SERVICE_BUS_WORKER = 'true';
    delete process.env.SERVICE_BUS_NAMESPACE;
    expect(() => new BillingMessageWorker().onModuleInit()).toThrow('Configuração incompleta');
    expect(ServiceBusClient).not.toHaveBeenCalled();
  });

  it('usa identidade de workload, confirmação manual e fecha os recursos', async () => {
    Object.assign(process.env, {
      ENABLE_SERVICE_BUS_WORKER: 'true', SERVICE_BUS_NAMESPACE: 'example.servicebus.windows.net',
      SERVICE_BUS_COMMAND_QUEUE: 'billing.commands', SERVICE_BUS_EVENT_TOPIC: 'soat.domain.events',
      DATABASE_URL: 'postgresql://local/test', AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_FEDERATED_TOKEN_FILE: '/tmp/token',
    });
    const worker = new BillingMessageWorker();
    worker.onModuleInit();
    expect(WorkloadIdentityCredential).toHaveBeenCalled();
    expect(receiver.subscribe).toHaveBeenCalledWith(expect.any(Object), { autoCompleteMessages: false, maxConcurrentCalls: 1 });
    await worker.onApplicationShutdown();
    expect(closeSubscription).toHaveBeenCalled();
    expect(receiver.close).toHaveBeenCalled();
    expect(sender.close).toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
    expect(prisma.$disconnect).toHaveBeenCalled();
  });

  it('não envia cobrança quando integração está desativada', async () => {
    Object.assign(process.env, { ENABLE_SERVICE_BUS_WORKER: 'true', SERVICE_BUS_NAMESPACE: 'example.servicebus.windows.net', SERVICE_BUS_COMMAND_QUEUE: 'billing.commands', SERVICE_BUS_EVENT_TOPIC: 'events', DATABASE_URL: 'postgresql://local/test', AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_FEDERATED_TOKEN_FILE: '/tmp/token' });
    const worker = new BillingMessageWorker(); worker.onModuleInit();
    const handlers = receiver.subscribe.mock.calls[0][0] as { processMessage(message: unknown): Promise<void> };
    const message = signed({ producer: 'soat-os-service' });
    await handlers.processMessage(message);
    expect(receiver.abandonMessage).toHaveBeenCalledWith(message);
    const forged = { ...message, body: { producer: 'soat-os-service', tampered: true } };
    await handlers.processMessage(forged);
    expect(receiver.deadLetterMessage).toHaveBeenCalledWith(forged, expect.objectContaining({ deadLetterReason: 'UnauthenticatedProducer' }));
    await worker.onApplicationShutdown();
  });
  it('exige token somente quando cobrança é explicitamente habilitada', () => {
    Object.assign(process.env, { ENABLE_SERVICE_BUS_WORKER: 'true', ENABLE_MERCADO_PAGO_COMMANDS: 'true', SERVICE_BUS_NAMESPACE: 'example.servicebus.windows.net', SERVICE_BUS_COMMAND_QUEUE: 'billing.commands', SERVICE_BUS_EVENT_TOPIC: 'events', DATABASE_URL: 'postgresql://local/test', AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_FEDERATED_TOKEN_FILE: '/tmp/token' });
    expect(() => new BillingMessageWorker().onModuleInit()).toThrow('Mercado Pago');
  });
  it('descarta eventos alheios à evidência sem preencher a DLQ e rejeita cancelamentos não autenticados', async () => {
    Object.assign(process.env, { ENABLE_SERVICE_BUS_WORKER: 'true', ENABLE_BILLING_COMPENSATION_EVIDENCE: 'true', EXECUTION_MESSAGE_PUBLIC_KEY: publicKey, SERVICE_BUS_BILLING_EVIDENCE_SUBSCRIPTION: 'billing-evidence', SERVICE_BUS_NAMESPACE: 'example.servicebus.windows.net', SERVICE_BUS_COMMAND_QUEUE: 'billing.commands', SERVICE_BUS_EVENT_TOPIC: 'events', DATABASE_URL: 'postgresql://local/test', AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_FEDERATED_TOKEN_FILE: '/tmp/token' });
    const worker = new BillingMessageWorker(); worker.onModuleInit();
    const handlers = receiver.subscribe.mock.calls[0][0] as { processMessage(message: unknown): Promise<void> };
    const unrelated = { subject: 'billing.quote-issued.v1', body: { type: 'billing.quote-issued.v1' } };
    await handlers.processMessage(unrelated);
    expect(receiver.completeMessage).toHaveBeenCalledWith(unrelated);
    const forged = { subject: 'execution.work-cancelled.v1', body: { type: 'execution.work-cancelled.v1' } };
    await handlers.processMessage(forged);
    expect(receiver.deadLetterMessage).toHaveBeenCalledWith(forged, expect.objectContaining({ deadLetterReason: 'InvalidEvidence' }));
    await worker.onApplicationShutdown();
  });
  it('reconcilia reembolsos pendentes somente quando habilitado e atualiza staging confirmado', async () => {
    Object.assign(process.env, { ENABLE_SERVICE_BUS_WORKER: 'true', ENABLE_BILLING_COMPENSATION_EVIDENCE: 'true', ENABLE_MERCADO_PAGO_REFUND_COMMANDS: 'true', ENABLE_MERCADO_PAGO_REFUND_RECONCILIATION: 'true', MERCADO_PAGO_ACCESS_TOKEN: 'test-token', EXECUTION_MESSAGE_PUBLIC_KEY: publicKey, SERVICE_BUS_BILLING_EVIDENCE_SUBSCRIPTION: 'billing-evidence', SERVICE_BUS_NAMESPACE: 'example.servicebus.windows.net', SERVICE_BUS_COMMAND_QUEUE: 'billing.commands', SERVICE_BUS_EVENT_TOPIC: 'events', DATABASE_URL: 'postgresql://local/test', AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_FEDERATED_TOKEN_FILE: '/tmp/token' });
    const processOne = jest.spyOn(RefundCommandProcessor.prototype, 'processOne').mockResolvedValue('EMPTY');
    const reconcile = jest.spyOn(ReconcileRefundService.prototype, 'execute').mockResolvedValue('REFUNDED');
    prisma.$queryRaw.mockResolvedValue([{ operationId: 'op' }]); prisma.inbox.updateMany.mockResolvedValue({ count: 1 });
    const worker = new BillingMessageWorker(); worker.onModuleInit(); await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reconcile).toHaveBeenCalledWith('op');
    expect(prisma.inbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ operationId: 'op', consumer: 'billing.refund-staging' }), data: expect.objectContaining({ status: 'REFUNDED' }) }));
    await worker.onApplicationShutdown(); processOne.mockRestore(); reconcile.mockRestore();
  });
  it('sinaliza reconciliação de reembolso sem registrar dados financeiros', async () => {
    Object.assign(process.env, { ENABLE_SERVICE_BUS_WORKER: 'true', ENABLE_BILLING_COMPENSATION_EVIDENCE: 'true', ENABLE_MERCADO_PAGO_REFUND_COMMANDS: 'true', MERCADO_PAGO_ACCESS_TOKEN: 'test-token', EXECUTION_MESSAGE_PUBLIC_KEY: publicKey, SERVICE_BUS_BILLING_EVIDENCE_SUBSCRIPTION: 'billing-evidence', SERVICE_BUS_NAMESPACE: 'example.servicebus.windows.net', SERVICE_BUS_COMMAND_QUEUE: 'billing.commands', SERVICE_BUS_EVENT_TOPIC: 'events', DATABASE_URL: 'postgresql://local/test', AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_FEDERATED_TOKEN_FILE: '/tmp/token' });
    const processOne = jest.spyOn(RefundCommandProcessor.prototype, 'processOne').mockResolvedValue('RECONCILIACAO_NECESSARIA');
    const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const worker = new BillingMessageWorker(); worker.onModuleInit(); await new Promise<void>((resolve) => setImmediate(resolve));
    expect(warning).toHaveBeenCalledWith('Reembolso requer reconciliação; consulte a inbox de Billing');
    await worker.onApplicationShutdown(); processOne.mockRestore(); warning.mockRestore();
  });
  it('continua o lote de reconciliação quando uma operação falha', async () => {
    Object.assign(process.env, { ENABLE_SERVICE_BUS_WORKER: 'true', ENABLE_BILLING_COMPENSATION_EVIDENCE: 'true', ENABLE_MERCADO_PAGO_REFUND_COMMANDS: 'true', ENABLE_MERCADO_PAGO_REFUND_RECONCILIATION: 'true', MERCADO_PAGO_ACCESS_TOKEN: 'test-token', EXECUTION_MESSAGE_PUBLIC_KEY: publicKey, SERVICE_BUS_BILLING_EVIDENCE_SUBSCRIPTION: 'billing-evidence', SERVICE_BUS_NAMESPACE: 'example.servicebus.windows.net', SERVICE_BUS_COMMAND_QUEUE: 'billing.commands', SERVICE_BUS_EVENT_TOPIC: 'events', DATABASE_URL: 'postgresql://local/test', AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_FEDERATED_TOKEN_FILE: '/tmp/token' });
    const processOne = jest.spyOn(RefundCommandProcessor.prototype, 'processOne').mockResolvedValue('EMPTY');
    const reconcile = jest.spyOn(ReconcileRefundService.prototype, 'execute').mockRejectedValueOnce(new Error('indisponível')).mockResolvedValueOnce('REFUNDED');
    const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    prisma.$queryRaw.mockResolvedValueOnce([{ operationId: 'failed' }, { operationId: 'succeeded' }]);
    const worker = new BillingMessageWorker(); worker.onModuleInit(); await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(prisma.inbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ operationId: 'succeeded' }) }));
    expect(warning).toHaveBeenCalledWith('Falha ao reconciliar reembolso; operação permanece pendente');
    await worker.onApplicationShutdown(); processOne.mockRestore(); reconcile.mockRestore(); warning.mockRestore();
  });
  it('reconcilia operações independentes mesmo quando outbox e processamento falham', async () => {
    Object.assign(process.env, { ENABLE_SERVICE_BUS_WORKER: 'true', ENABLE_BILLING_COMPENSATION_EVIDENCE: 'true', ENABLE_MERCADO_PAGO_REFUND_COMMANDS: 'true', ENABLE_MERCADO_PAGO_REFUND_RECONCILIATION: 'true', MERCADO_PAGO_ACCESS_TOKEN: 'test-token', EXECUTION_MESSAGE_PUBLIC_KEY: publicKey, SERVICE_BUS_BILLING_EVIDENCE_SUBSCRIPTION: 'billing-evidence', SERVICE_BUS_NAMESPACE: 'example.servicebus.windows.net', SERVICE_BUS_COMMAND_QUEUE: 'billing.commands', SERVICE_BUS_EVENT_TOPIC: 'events', DATABASE_URL: 'postgresql://local/test', AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_FEDERATED_TOKEN_FILE: '/tmp/token' });
    dispatcher.dispatchOne.mockRejectedValueOnce(new Error('broker indisponível'));
    const processOne = jest.spyOn(RefundCommandProcessor.prototype, 'processOne').mockRejectedValueOnce(new Error('comando indisponível'));
    const reconcile = jest.spyOn(ReconcileRefundService.prototype, 'execute').mockResolvedValueOnce('RECONCILIACAO_NECESSARIA');
    prisma.$queryRaw.mockResolvedValueOnce([{ operationId: 'uncertain' }]);
    const worker = new BillingMessageWorker(); worker.onModuleInit(); await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reconcile).toHaveBeenCalledWith('uncertain');
    expect(prisma.inbox.updateMany).not.toHaveBeenCalled();
    await worker.onApplicationShutdown(); processOne.mockRestore(); reconcile.mockRestore();
  });
  it('percorre lotes pendentes sem deixar reembolsos seguintes presos aos primeiros', async () => {
    Object.assign(process.env, { ENABLE_SERVICE_BUS_WORKER: 'true', ENABLE_BILLING_COMPENSATION_EVIDENCE: 'true', ENABLE_MERCADO_PAGO_REFUND_COMMANDS: 'true', ENABLE_MERCADO_PAGO_REFUND_RECONCILIATION: 'true', MERCADO_PAGO_ACCESS_TOKEN: 'test-token', EXECUTION_MESSAGE_PUBLIC_KEY: publicKey, SERVICE_BUS_BILLING_EVIDENCE_SUBSCRIPTION: 'billing-evidence', SERVICE_BUS_NAMESPACE: 'example.servicebus.windows.net', SERVICE_BUS_COMMAND_QUEUE: 'billing.commands', SERVICE_BUS_EVENT_TOPIC: 'events', DATABASE_URL: 'postgresql://local/test', AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_FEDERATED_TOKEN_FILE: '/tmp/token' });
    const processOne = jest.spyOn(RefundCommandProcessor.prototype, 'processOne').mockResolvedValue('EMPTY');
    const reconcile = jest.spyOn(ReconcileRefundService.prototype, 'execute').mockResolvedValue('RECONCILIACAO_NECESSARIA');
    const first = Array.from({ length: 20 }, (_, i) => ({ operationId: `op-${String(i).padStart(2, '0')}` }));
    prisma.$queryRaw.mockResolvedValueOnce(first).mockResolvedValueOnce([{ operationId: 'op-20' }]).mockResolvedValueOnce([]);
    const worker = new BillingMessageWorker(); worker.onModuleInit(); await new Promise<void>((resolve) => setImmediate(resolve));
    const internal = worker as unknown as { nextRefundReconciliation: number; poll(): Promise<void> };
    internal.nextRefundReconciliation = 0; await internal.poll();
    internal.nextRefundReconciliation = 0; await internal.poll();
    expect(prisma.$queryRaw.mock.calls.map(call => call[2])).toEqual(['', 'op-19', '']);
    expect(reconcile).toHaveBeenCalledWith('op-20');
    expect(prisma.inbox.updateMany).not.toHaveBeenCalled();
    await worker.onApplicationShutdown(); processOne.mockRestore(); reconcile.mockRestore();
  });
  it('direciona comando de cobrança inválido ao consumidor habilitado', async () => {
    Object.assign(process.env, { ENABLE_SERVICE_BUS_WORKER: 'true', ENABLE_MERCADO_PAGO_COMMANDS: 'true', MERCADO_PAGO_ACCESS_TOKEN: 'test-token', SERVICE_BUS_NAMESPACE: 'example.servicebus.windows.net', SERVICE_BUS_COMMAND_QUEUE: 'billing.commands', SERVICE_BUS_EVENT_TOPIC: 'events', DATABASE_URL: 'postgresql://local/test', AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_FEDERATED_TOKEN_FILE: '/tmp/token' });
    const worker = new BillingMessageWorker(); worker.onModuleInit();
    const handlers = receiver.subscribe.mock.calls[0][0] as { processMessage(message: unknown): Promise<void> };
    await handlers.processMessage(signed({ producer: 'soat-os-service' }));
    expect(receiver.deadLetterMessage).toHaveBeenCalledTimes(1);
    await worker.onApplicationShutdown();
  });

  it('encerra os demais recursos mesmo se fechar a assinatura falhar', async () => {
    Object.assign(process.env, {
      ENABLE_SERVICE_BUS_WORKER: 'true', SERVICE_BUS_NAMESPACE: 'example.servicebus.windows.net',
      SERVICE_BUS_COMMAND_QUEUE: 'billing.commands', SERVICE_BUS_EVENT_TOPIC: 'soat.domain.events',
      DATABASE_URL: 'postgresql://local/test', AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_FEDERATED_TOKEN_FILE: '/tmp/token',
    });
    closeSubscription.mockRejectedValueOnce(new Error('close failed'));
    const worker = new BillingMessageWorker();
    worker.onModuleInit();
    await worker.onApplicationShutdown();
    expect(client.close).toHaveBeenCalled();
    expect(prisma.$disconnect).toHaveBeenCalled();
  });
});
