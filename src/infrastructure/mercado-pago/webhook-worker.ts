import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ProcessMercadoPagoWebhook } from '../../application/processar-webhook';
import { MercadoPagoOrdersClient } from './orders-client';

type Cursor = { receivedAt: Date; eventId: string };

/** Provider reads may repeat; financial writes are serialized by the application service. */
@Injectable()
export class MercadoPagoWebhookWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MercadoPagoWebhookWorker.name);
  private db?: PrismaClient;
  private processor?: ProcessMercadoPagoWebhook;
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private cursor?: Cursor;
  private stopping = false;

  onModuleInit(): void {
    if (process.env.ENABLE_MERCADO_PAGO_WEBHOOK_PROCESSOR !== 'true') return;
    const token = process.env.MERCADO_PAGO_ACCESS_TOKEN;
    if (!token || !process.env.DATABASE_URL) throw new Error('Configuração incompleta do processador de webhook');
    this.db = new PrismaClient();
    this.processor = new ProcessMercadoPagoWebhook(this.db, new MercadoPagoOrdersClient(token));
    this.active = this.poll();
  }

  private async poll(): Promise<void> {
    if (this.stopping || !this.db || !this.processor) return;
    let delay = 60000;
    try {
      const cursor = this.cursor;
      const rows = await this.db.receivedWebhook.findMany({ where: { provider: 'mercado-pago-orders', status: 'RECEIVED', ...(cursor ? { OR: [{ receivedAt: { gt: cursor.receivedAt } }, { receivedAt: cursor.receivedAt, eventId: { gt: cursor.eventId } }] } : {}) }, orderBy: [{ receivedAt: 'asc' }, { eventId: 'asc' }], take: 50, select: { eventId: true, receivedAt: true } });
      for (const row of rows) {
        if (this.stopping) break;
        try { await this.processor.execute(row.eventId); } catch { this.logger.warn('Não foi possível processar notificação; será reavaliada'); }
      }
      const last = rows.at(-1);
      this.cursor = rows.length === 50 && last ? { receivedAt: last.receivedAt, eventId: last.eventId } : undefined;
      if (this.cursor) delay = 0;
    } catch {
      this.cursor = undefined;
      this.logger.error('Falha ao consultar notificações pendentes');
    }
    if (!this.stopping) this.timer = setTimeout(() => { this.active = this.poll(); }, delay);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    try { await this.active; } catch { this.logger.error('Falha ao encerrar processamento'); }
    try { await this.db?.$disconnect(); } catch { this.logger.error('Falha ao encerrar conexão'); }
  }
}
