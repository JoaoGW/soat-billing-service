import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { WorkloadIdentityCredential } from '@azure/identity';
import { ServiceBusClient, ServiceBusReceiver, ServiceBusSender } from '@azure/service-bus';
import { PrismaClient } from '@prisma/client';
import { resolve } from 'node:path';
import { GenerateQuoteService } from '../../application/gerar-orcamento';
import { OutboxDispatcher } from '../../application/publicar-outbox';
import { createQuoteCommandValidator, ServiceBusCommandConsumer } from './command-consumer';
import { ServiceBusEventPublisher } from './event-publisher';

@Injectable()
export class BillingMessageWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(BillingMessageWorker.name);
  private client?: ServiceBusClient;
  private sender?: ServiceBusSender;
  private receiver?: ServiceBusReceiver;
  private subscription?: { close(): Promise<void> };
  private prisma?: PrismaClient;
  private dispatcher?: OutboxDispatcher;
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopping = false;

  onModuleInit(): void {
    if (process.env.ENABLE_SERVICE_BUS_WORKER !== 'true') return;
    const namespace = process.env.SERVICE_BUS_NAMESPACE;
    const queue = process.env.SERVICE_BUS_COMMAND_QUEUE;
    const topic = process.env.SERVICE_BUS_EVENT_TOPIC;
    if (!namespace || !/^[a-z0-9-]+\.servicebus\.windows\.net$/i.test(namespace) ||
        !queue || !topic || !process.env.DATABASE_URL || !process.env.AZURE_TENANT_ID ||
        !process.env.AZURE_CLIENT_ID || !process.env.AZURE_FEDERATED_TOKEN_FILE) {
      throw new Error('Configuração incompleta do worker Service Bus');
    }
    const validator = createQuoteCommandValidator(resolve(process.cwd(), 'docs/contracts/messages'));
    this.prisma = new PrismaClient();
    this.client = new ServiceBusClient(namespace, new WorkloadIdentityCredential());
    this.sender = this.client.createSender(topic);
    this.receiver = this.client.createReceiver(queue, { receiveMode: 'peekLock' });
    this.dispatcher = new OutboxDispatcher(this.prisma, new ServiceBusEventPublisher(this.sender));
    const receiver = this.receiver;
    const consumer = new ServiceBusCommandConsumer(new GenerateQuoteService(this.prisma), validator);
    this.subscription = receiver.subscribe({
      processMessage: (message) => consumer.process(message, receiver),
      processError: async (args) => { this.logger.error(`Falha no transporte Service Bus: ${args.errorSource}`); },
    }, { autoCompleteMessages: false, maxConcurrentCalls: 1 });
    this.active = this.poll();
  }

  private async poll(): Promise<void> {
    if (this.stopping || !this.dispatcher) return;
    try { await this.dispatcher.dispatchOne(); }
    catch { this.logger.error('Falha ao processar outbox'); }
    if (!this.stopping) this.timer = setTimeout(() => { this.active = this.poll(); }, 1000);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    const close = async (action: () => Promise<unknown> | undefined) => {
      try { await action(); }
      catch { this.logger.error('Falha ao encerrar recurso do worker'); }
    };
    await close(() => this.subscription?.close());
    await close(() => this.active);
    await close(() => this.receiver?.close());
    await close(() => this.sender?.close());
    await close(() => this.client?.close());
    await close(() => this.prisma?.$disconnect());
  }
}
