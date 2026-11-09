import nodemailer from 'nodemailer';
import { PrismaClient } from '@prisma/client';
import { NotificationDispatcher } from '../../application/enviar-notificacao';
import { BillingNotificationWorker } from './worker';

jest.mock('nodemailer');
jest.mock('@prisma/client');
jest.mock('../../application/enviar-notificacao');

describe('BillingNotificationWorker', () => {
  const originalEnv = process.env;
  const transport = { sendMail: jest.fn(), close: jest.fn() };
  const prisma = { $disconnect: jest.fn().mockResolvedValue(undefined) };
  const dispatcher = { dispatchOne: jest.fn().mockResolvedValue('EMPTY') };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, ENABLE_NOTIFICATION_WORKER: 'false' };
    jest.mocked(nodemailer.createTransport).mockReturnValue(transport as never);
    jest.mocked(PrismaClient).mockImplementation(() => prisma as unknown as PrismaClient);
    jest.mocked(NotificationDispatcher).mockImplementation(() => dispatcher as unknown as NotificationDispatcher);
  });
  afterEach(() => { process.env = originalEnv; });
  it('não abre SMTP quando desativado', async () => {
    const worker = new BillingNotificationWorker();
    worker.onModuleInit();
    await worker.onApplicationShutdown();
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });
  it('exige configuração completa ao habilitar', () => {
    process.env.ENABLE_NOTIFICATION_WORKER = 'true';
    delete process.env.MAIL_HOST;
    expect(() => new BillingNotificationWorker().onModuleInit()).toThrow('Configuração incompleta');
  });
  it('exige TLS e fecha recursos ao encerrar', async () => {
    Object.assign(process.env, { ENABLE_NOTIFICATION_WORKER: 'true', MAIL_HOST: 'smtp.example.test', MAIL_PORT: '587', MAIL_USER: 'user', MAIL_PASS: 'secret', MAIL_FROM: 'office@example.test', DATABASE_URL: 'postgresql://local/test' });
    const worker = new BillingNotificationWorker();
    worker.onModuleInit();
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: false, requireTLS: true, port: 587 }));
    await worker.onApplicationShutdown();
    expect(transport.close).toHaveBeenCalled();
    expect(prisma.$disconnect).toHaveBeenCalled();
  });
});
