import { PrismaClient } from '@prisma/client';
import { ProcessMercadoPagoWebhook } from '../../application/processar-webhook';
import { MercadoPagoWebhookWorker } from './webhook-worker';

jest.mock('@prisma/client');
jest.mock('../../application/processar-webhook');

describe('MercadoPagoWebhookWorker', () => {
  const original = process.env;
  const db = { receivedWebhook: { findMany: jest.fn() }, $disconnect: jest.fn().mockResolvedValue(undefined) };
  const processor = { execute: jest.fn() };
  beforeEach(() => {
    jest.clearAllMocks(); jest.useFakeTimers(); process.env = { ...original }; delete process.env.ENABLE_MERCADO_PAGO_WEBHOOK_PROCESSOR;
    jest.mocked(PrismaClient).mockImplementation(() => db as unknown as PrismaClient);
    jest.mocked(ProcessMercadoPagoWebhook).mockImplementation(() => processor as unknown as ProcessMercadoPagoWebhook);
    db.receivedWebhook.findMany.mockResolvedValue([]); processor.execute.mockResolvedValue('APPLIED');
  });
  afterEach(() => { process.env = original; jest.useRealTimers(); });
  it('não acessa banco nem provedor por padrão', async () => {
    const worker = new MercadoPagoWebhookWorker(); worker.onModuleInit(); await worker.onApplicationShutdown();
    expect(PrismaClient).not.toHaveBeenCalled();
  });
  it('exige token e banco se habilitado', () => {
    process.env.ENABLE_MERCADO_PAGO_WEBHOOK_PROCESSOR = 'true'; delete process.env.MERCADO_PAGO_ACCESS_TOKEN;
    expect(() => new MercadoPagoWebhookWorker().onModuleInit()).toThrow('Configuração incompleta');
  });
  it('percorre páginas e encerra a conexão', async () => {
    Object.assign(process.env, { ENABLE_MERCADO_PAGO_WEBHOOK_PROCESSOR: 'true', MERCADO_PAGO_ACCESS_TOKEN: 'test', DATABASE_URL: 'postgresql://localhost/db' });
    const rows = Array.from({ length: 50 }, (_, index) => ({ eventId: `event-${index}`, receivedAt: new Date('2030-01-01') }));
    db.receivedWebhook.findMany.mockResolvedValueOnce(rows).mockResolvedValue([]);
    const worker = new MercadoPagoWebhookWorker(); worker.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(processor.execute).toHaveBeenCalledTimes(50);
    expect(db.receivedWebhook.findMany).toHaveBeenCalledTimes(2);
    expect(db.receivedWebhook.findMany.mock.calls[1][0].where.OR).toBeDefined();
    await worker.onApplicationShutdown();
    expect(db.$disconnect).toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
  });
});
