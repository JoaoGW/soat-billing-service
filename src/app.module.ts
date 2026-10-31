import { Controller, Get, Module } from '@nestjs/common';
import { BillingMessageWorker } from './infrastructure/service-bus/worker';
import { BillingDatabase } from './infrastructure/billing-database';
import { QuoteDecisionService } from './application/decidir-orcamento';
import { ClienteGuard } from './interfaces/cliente-guard';
import { OrcamentoController } from './interfaces/orcamento-controller';

@Controller()
export class HealthController {
  @Get('health')
  health() {
    return { status: 'ok', service: process.env.OTEL_SERVICE_NAME ?? 'soat-billing-service' };
  }
}

@Module({
  controllers: [HealthController, OrcamentoController],
  providers: [BillingMessageWorker, BillingDatabase, ClienteGuard, { provide: QuoteDecisionService, useFactory: (database: BillingDatabase) => new QuoteDecisionService(database), inject: [BillingDatabase] }],
})
export class AppModule {}
