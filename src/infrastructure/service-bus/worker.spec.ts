import { WorkloadIdentityCredential } from '@azure/identity';
import { ServiceBusClient } from '@azure/service-bus';
import { PrismaClient } from '@prisma/client';
import { OutboxDispatcher } from '../../application/publicar-outbox';
import { BillingMessageWorker } from './worker';

jest.mock('@azure/identity');
jest.mock('@azure/service-bus');
jest.mock('@prisma/client');
jest.mock('../../application/publicar-outbox');

describe('BillingMessageWorker', () => {
  const originalEnv = process.env;
  const closeSubscription = jest.fn().mockResolvedValue(undefined);
  const receiver = { subscribe: jest.fn(), close: jest.fn().mockResolvedValue(undefined), abandonMessage: jest.fn().mockResolvedValue(undefined), deadLetterMessage: jest.fn().mockResolvedValue(undefined) };
  const sender = { close: jest.fn().mockResolvedValue(undefined) };
  const client = { createSender: jest.fn(), createReceiver: jest.fn(), close: jest.fn().mockResolvedValue(undefined) };
  const prisma = { $disconnect: jest.fn().mockResolvedValue(undefined) };
  const dispatcher = { dispatchOne: jest.fn().mockResolvedValue('EMPTY') };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, ENABLE_SERVICE_BUS_WORKER: 'false', ENABLE_MERCADO_PAGO_COMMANDS: 'false' };
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
    const message = { subject: 'billing.create-charge.v1', body: {} };
    await handlers.processMessage(message);
    expect(receiver.abandonMessage).toHaveBeenCalledWith(message);
    await worker.onApplicationShutdown();
  });
  it('exige token somente quando cobrança é explicitamente habilitada', () => {
    Object.assign(process.env, { ENABLE_SERVICE_BUS_WORKER: 'true', ENABLE_MERCADO_PAGO_COMMANDS: 'true', SERVICE_BUS_NAMESPACE: 'example.servicebus.windows.net', SERVICE_BUS_COMMAND_QUEUE: 'billing.commands', SERVICE_BUS_EVENT_TOPIC: 'events', DATABASE_URL: 'postgresql://local/test', AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_FEDERATED_TOKEN_FILE: '/tmp/token' });
    expect(() => new BillingMessageWorker().onModuleInit()).toThrow('Mercado Pago');
  });
  it('direciona comando de cobrança inválido ao consumidor habilitado', async () => {
    Object.assign(process.env, { ENABLE_SERVICE_BUS_WORKER: 'true', ENABLE_MERCADO_PAGO_COMMANDS: 'true', MERCADO_PAGO_ACCESS_TOKEN: 'test-token', SERVICE_BUS_NAMESPACE: 'example.servicebus.windows.net', SERVICE_BUS_COMMAND_QUEUE: 'billing.commands', SERVICE_BUS_EVENT_TOPIC: 'events', DATABASE_URL: 'postgresql://local/test', AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_FEDERATED_TOKEN_FILE: '/tmp/token' });
    const worker = new BillingMessageWorker(); worker.onModuleInit();
    const handlers = receiver.subscribe.mock.calls[0][0] as { processMessage(message: unknown): Promise<void> };
    await handlers.processMessage({ subject: 'billing.create-charge.v1', body: {} });
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
