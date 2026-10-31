import { Controller, Get, Module } from '@nestjs/common';
import { BillingMessageWorker } from './infrastructure/service-bus/worker';

@Controller()
export class HealthController {
  @Get('health')
  health() {
    return { status: 'ok', service: process.env.OTEL_SERVICE_NAME ?? 'soat-billing-service' };
  }
}

@Module({ controllers: [HealthController], providers: [BillingMessageWorker] })
export class AppModule {}
