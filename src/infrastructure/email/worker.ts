import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import nodemailer, { Transporter } from 'nodemailer';
import { NotificationDispatcher } from '../../application/enviar-notificacao';
import { SmtpQuoteNotifier } from './quote-notifier';

@Injectable()
export class BillingNotificationWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(BillingNotificationWorker.name);
  private prisma?: PrismaClient;
  private transport?: Transporter;
  private dispatcher?: NotificationDispatcher;
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopping = false;

  onModuleInit(): void {
    if (process.env.ENABLE_NOTIFICATION_WORKER !== 'true') return;
    const { MAIL_HOST, MAIL_PORT, MAIL_USER, MAIL_PASS, MAIL_FROM, DATABASE_URL } = process.env;
    const port = Number(MAIL_PORT);
    if (!MAIL_HOST || !MAIL_USER || !MAIL_PASS || !MAIL_FROM || !DATABASE_URL || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Configuração incompleta do worker de notificações');
    this.prisma = new PrismaClient();
    this.transport = nodemailer.createTransport({ host: MAIL_HOST, port, secure: port === 465, requireTLS: port !== 465, auth: { user: MAIL_USER, pass: MAIL_PASS } });
    this.dispatcher = new NotificationDispatcher(this.prisma, new SmtpQuoteNotifier(this.transport, MAIL_FROM));
    this.active = this.poll();
  }

  private async poll(): Promise<void> {
    if (this.stopping || !this.dispatcher) return;
    try { await this.dispatcher.dispatchOne(); }
    catch { this.logger.error('Falha ao processar notificações'); }
    if (!this.stopping) this.timer = setTimeout(() => { this.active = this.poll(); }, 1000);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    try { await this.active; } catch { this.logger.error('Falha ao encerrar notificação em andamento'); }
    try { this.transport?.close(); } catch { this.logger.error('Falha ao encerrar transporte SMTP'); }
    try { await this.prisma?.$disconnect(); } catch { this.logger.error('Falha ao encerrar conexão de notificações'); }
  }
}
