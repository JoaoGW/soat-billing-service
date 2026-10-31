import { Controller, Get, Module } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  health() {
    return { status: 'ok', service: process.env.OTEL_SERVICE_NAME ?? 'soat-billing-service' };
  }
}

@Module({ controllers: [HealthController] })
export class AppModule {}
