import { BadRequestException, Body, Controller, Headers, HttpCode, Inject, Post, Query, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { InvalidWebhookPayload, InvalidWebhookSignature, RegisterMercadoPagoWebhook } from '../application/registrar-webhook';
import { BillingDatabase } from '../infrastructure/billing-database';

/** Ingress is disabled until the reconciliation worker is ready and configured. */
@Controller('webhooks')
export class MercadoPagoWebhookController {
  constructor(@Inject(BillingDatabase) private readonly db: BillingDatabase) {}

  @Post('mercado-pago')
  @HttpCode(200)
  async receive(@Headers('x-signature') signature: unknown, @Headers('x-request-id') requestId: unknown, @Query('data.id') dataId: unknown, @Body() body: unknown): Promise<void> {
    if (process.env.ENABLE_MERCADO_PAGO_WEBHOOK !== 'true' || process.env.ENABLE_MERCADO_PAGO_WEBHOOK_PROCESSOR !== 'true') throw new ServiceUnavailableException();
    const secret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
    if (!secret) throw new ServiceUnavailableException();
    if (typeof signature !== 'string' || typeof requestId !== 'string' || typeof dataId !== 'string') throw new BadRequestException();
    try {
      await new RegisterMercadoPagoWebhook(this.db, secret).execute({ signature, requestId, dataId, body });
    } catch (error) {
      if (error instanceof InvalidWebhookSignature) throw new UnauthorizedException();
      if (error instanceof InvalidWebhookPayload) throw new BadRequestException();
      throw new ServiceUnavailableException();
    }
  }
}
