import { HealthController } from './app.module';

describe('health', () => {
  it('identifica o processo sem expor configuração', () => {
    expect(new HealthController().health()).toEqual({
      status: 'ok',
      service: process.env.OTEL_SERVICE_NAME ?? 'soat-billing-service',
    });
  });
});
