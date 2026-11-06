import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { WorkloadIdentityCredential } from '@azure/identity';
import { ServiceBusClient, ServiceBusReceiver, ServiceBusSender } from '@azure/service-bus';
import { PrismaClient } from '@prisma/client';
import { resolve } from 'node:path';
import { GenerateQuoteService } from '../../application/gerar-orcamento';
import { OutboxDispatcher } from '../../application/publicar-outbox';
import { createQuoteCommandValidator, ServiceBusCommandConsumer } from './command-consumer';
import { ServiceBusEventPublisher } from './event-publisher';
import { ChargeCommandConsumer, createChargeCommandValidator } from './charge-consumer';
import { PrepareChargeService } from '../../application/preparar-cobranca';
import { SubmitChargeService } from '../../application/enviar-cobranca';
import { MercadoPagoOrdersClient } from '../mercado-pago/orders-client';
import { MessageSigner, MessageVerifier } from './message-signature';
import { CompensationEvidenceConsumer, evidenceValidator } from './compensation-evidence';
import { RefundCommandConsumer, RefundCommandProcessor, refundCommandValidator } from './refund-command';
import { PrepareRefundService, SubmitRefundService, ConfirmRefundService } from '../../application/reembolsar-pagamento';
import { ReconcileRefundService } from '../../application/reconciliar-reembolso';
import { withMessageTrace } from '../observability/message-trace';

@Injectable()
export class BillingMessageWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(BillingMessageWorker.name);
  private client?: ServiceBusClient;
  private sender?: ServiceBusSender;
  private receiver?: ServiceBusReceiver;
  private subscription?: { close(): Promise<void> };
  private evidenceReceiver?: ServiceBusReceiver;
  private evidenceSubscription?: { close(): Promise<void> };
  private prisma?: PrismaClient;
  private dispatcher?: OutboxDispatcher;
  private refundProcessor?: RefundCommandProcessor;
  private refundReconciler?: ReconcileRefundService;
  private nextRefundReconciliation = 0;
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopping = false;

  onModuleInit(): void {
    if (process.env.ENABLE_SERVICE_BUS_WORKER !== 'true') return;
    const namespace = process.env.SERVICE_BUS_NAMESPACE;
    const queue = process.env.SERVICE_BUS_COMMAND_QUEUE;
    const topic = process.env.SERVICE_BUS_EVENT_TOPIC;
    const signingKey = process.env.BILLING_MESSAGE_PRIVATE_KEY; const osKey = process.env.OS_MESSAGE_PUBLIC_KEY;
    if (!signingKey || !osKey || !namespace || !/^[a-z0-9-]+\.servicebus\.windows\.net$/i.test(namespace) ||
        !queue || !topic || !process.env.DATABASE_URL || !process.env.AZURE_TENANT_ID ||
        !process.env.AZURE_CLIENT_ID || !process.env.AZURE_FEDERATED_TOKEN_FILE) {
      throw new Error('Configuração incompleta do worker Service Bus');
    }
    const signer = new MessageSigner(signingKey); const verifier = new MessageVerifier(osKey, 'soat-os-service');
    const evidenceEnabled = process.env.ENABLE_BILLING_COMPENSATION_EVIDENCE === 'true';
    const evidenceKey = process.env.EXECUTION_MESSAGE_PUBLIC_KEY; const evidenceSubscription = process.env.SERVICE_BUS_BILLING_EVIDENCE_SUBSCRIPTION;
    if (evidenceEnabled && (!evidenceKey || !evidenceSubscription)) throw new Error('Configuração incompleta da evidência de compensação');
    const evidenceVerifier = evidenceEnabled && evidenceKey ? new MessageVerifier(evidenceKey, 'soat-execution-service') : undefined;
    const validator = createQuoteCommandValidator(resolve(process.cwd(), 'docs/contracts/messages'));
    const chargeEnabled = process.env.ENABLE_MERCADO_PAGO_COMMANDS === 'true';
    const refundEnabled = process.env.ENABLE_MERCADO_PAGO_REFUND_COMMANDS === 'true';
    const reconcileEnabled = process.env.ENABLE_MERCADO_PAGO_REFUND_RECONCILIATION === 'true';
    const token = process.env.MERCADO_PAGO_ACCESS_TOKEN;
    if ((chargeEnabled || refundEnabled) && !token) throw new Error('Configuração incompleta do Mercado Pago');
    if (refundEnabled && !evidenceEnabled) throw new Error('Evidência de compensação não configurada');
    if (reconcileEnabled && !refundEnabled) throw new Error('Reembolso não configurado para reconciliação');
    const chargeValidator = chargeEnabled ? createChargeCommandValidator(resolve(process.cwd(), 'docs/contracts/messages')) : undefined;
    this.prisma = new PrismaClient();
    this.client = new ServiceBusClient(namespace, new WorkloadIdentityCredential());
    this.sender = this.client.createSender(topic);
    this.receiver = this.client.createReceiver(queue, { receiveMode: 'peekLock' });
    if (evidenceEnabled && evidenceSubscription && evidenceVerifier) {
      const evidenceConsumer = new CompensationEvidenceConsumer(this.prisma, evidenceVerifier, evidenceValidator(resolve(process.cwd(), 'docs/contracts/messages')));
      this.evidenceReceiver = this.client.createReceiver(topic, evidenceSubscription, { receiveMode: 'peekLock' });
      const evidenceReceiver = this.evidenceReceiver;
      this.evidenceSubscription = evidenceReceiver.subscribe({ processMessage: async (message) => {
        const body: unknown = message.body;
        const type = body && typeof body === 'object' && 'type' in body ? body.type : undefined;
        if (message.subject !== 'execution.work-cancelled.v1' && type !== 'execution.work-cancelled.v1') {
          await evidenceReceiver.completeMessage(message); return;
        }
        await evidenceConsumer.process(message, evidenceReceiver);
      }, processError: async (args) => { this.logger.error(`Falha ao receber evidência: ${args.errorSource}`); } }, { autoCompleteMessages: false, maxConcurrentCalls: 1 });
    }
    this.dispatcher = new OutboxDispatcher(this.prisma, new ServiceBusEventPublisher(this.sender, signer));
    const receiver = this.receiver;
    const consumer = new ServiceBusCommandConsumer(new GenerateQuoteService(this.prisma), validator);
    const chargeConsumer = chargeEnabled && token && chargeValidator
      ? new ChargeCommandConsumer(new PrepareChargeService(this.prisma), new SubmitChargeService(this.prisma, new MercadoPagoOrdersClient(token)), chargeValidator)
      : undefined;
    const refundValidator = refundEnabled ? refundCommandValidator(resolve(process.cwd(), 'docs/contracts/messages')) : undefined;
    const refundConsumer = refundValidator ? new RefundCommandConsumer(this.prisma, refundValidator) : undefined;
    if (refundEnabled && refundValidator && token) {
      const provider = new MercadoPagoOrdersClient(token);
      this.refundProcessor = new RefundCommandProcessor(this.prisma, new PrepareRefundService(this.prisma), new SubmitRefundService(this.prisma, provider), new ConfirmRefundService(this.prisma, provider), refundValidator);
      if (reconcileEnabled) this.refundReconciler = new ReconcileRefundService(this.prisma, provider);
    }
    this.subscription = receiver.subscribe({
      processMessage: async (message) => {
        if (!verifier.verify(message.body, message.applicationProperties?.signature)) {
          await receiver.deadLetterMessage(message, { deadLetterReason: 'UnauthenticatedProducer', deadLetterErrorDescription: 'Assinatura inválida' }); return;
        }
        return withMessageTrace(message.body, async () => {
        const isRefund = message.subject === 'billing.refund-payment.v1' || (message.body && typeof message.body === 'object' && message.body.type === 'billing.refund-payment.v1');
        if (isRefund) return refundConsumer ? refundConsumer.process(message, receiver) : receiver.abandonMessage(message);
        const isCharge = message.subject === 'billing.create-charge.v1' ||
          (message.body && typeof message.body === 'object' && message.body.type === 'billing.create-charge.v1');
        if (!isCharge) return consumer.process(message, receiver);
        if (!chargeConsumer) return receiver.abandonMessage(message);
        return chargeConsumer.process(message, receiver);
        });
      },
      processError: async (args) => { this.logger.error(`Falha no transporte Service Bus: ${args.errorSource}`); },
    }, { autoCompleteMessages: false, maxConcurrentCalls: 1 });
    this.active = this.poll();
  }

  private async poll(): Promise<void> {
    if (this.stopping || !this.dispatcher) return;
    try {
      await this.dispatcher.dispatchOne();
      if (await this.refundProcessor?.processOne() === 'RECONCILIACAO_NECESSARIA')
        this.logger.warn('Reembolso requer reconciliação; consulte a inbox de Billing');
      if (this.refundReconciler && this.prisma && Date.now() >= this.nextRefundReconciliation) {
        this.nextRefundReconciliation = Date.now() + 60000;
        const older = new Date(Date.now() - 60000);
        const rows = await this.prisma.$queryRaw<Array<{ operationId: string }>>`SELECT r."operationId" FROM "Refund" r WHERE r."updatedAt" <= ${older} AND (r."status" IN ('IN_FLIGHT','RECONCILIACAO_NECESSARIA','PENDING_CONFIRMATION') OR (r."status"='REFUNDED' AND EXISTS (SELECT 1 FROM "Inbox" i WHERE i."consumer"='billing.refund-staging' AND i."operationId"=r."operationId" AND i."status" IN ('PENDING','RECONCILIACAO_NECESSARIA')))) ORDER BY random() LIMIT 1`;
        if (rows[0] && await this.refundReconciler.execute(rows[0].operationId) === 'REFUNDED')
          await this.prisma.inbox.updateMany({ where: { consumer: 'billing.refund-staging', operationId: rows[0].operationId, status: { in: ['PENDING', 'RECONCILIACAO_NECESSARIA'] } }, data: { status: 'REFUNDED', appliedAt: new Date() } });
      }
    }
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
    await close(() => this.evidenceSubscription?.close());
    await close(() => this.active);
    await close(() => this.receiver?.close());
    await close(() => this.evidenceReceiver?.close());
    await close(() => this.sender?.close());
    await close(() => this.client?.close());
    await close(() => this.prisma?.$disconnect());
  }
}
