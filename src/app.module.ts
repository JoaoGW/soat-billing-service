import { Controller, Get, Module } from '@nestjs/common';
import { BillingMessageWorker } from './infrastructure/service-bus/worker';
import { BillingDatabase } from './infrastructure/billing-database';
import { QuoteDecisionService } from './application/decidir-orcamento';
import { QuoteQueryService } from './application/consultar-orcamento';
import { ClienteGuard } from './interfaces/cliente-guard';
import { OrcamentoController } from './interfaces/orcamento-controller';
import { BillingNotificationWorker } from './infrastructure/email/worker';
import { MercadoPagoWebhookController } from './interfaces/mercado-pago-webhook-controller';
import { MercadoPagoWebhookWorker } from './infrastructure/mercado-pago/webhook-worker';
import { ChargeQueryService } from './application/consultar-cobranca';
import { CobrancaController } from './interfaces/cobranca-controller';

@Controller()
export class HealthController {
  @Get('health')
  health() {
    return { status: 'ok', service: process.env.OTEL_SERVICE_NAME ?? 'soat-billing-service' };
  }
}

@Module({
  controllers: [HealthController, OrcamentoController, CobrancaController, MercadoPagoWebhookController],
  providers: [MercadoPagoWebhookWorker, BillingMessageWorker, BillingNotificationWorker, BillingDatabase, ClienteGuard, { provide: QuoteDecisionService, useFactory: (database: BillingDatabase) => new QuoteDecisionService(database), inject: [BillingDatabase] }, { provide: QuoteQueryService, useFactory: (database: BillingDatabase) => new QuoteQueryService(database), inject: [BillingDatabase] }, { provide: ChargeQueryService, useFactory: (database: BillingDatabase) => new ChargeQueryService(database), inject: [BillingDatabase] }],
})
export class AppModule {}
