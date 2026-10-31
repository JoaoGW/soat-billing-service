import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Headers, HttpCode, Inject, NotFoundException, Param, Post, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { QuoteDecisionService } from '../application/decidir-orcamento';
import { Decision } from '../domain/orcamento';
import { ClienteGuard, ClienteRequest } from './cliente-guard';

@Controller('orcamentos')
@UseGuards(ClienteGuard)
export class OrcamentoController {
  constructor(@Inject(QuoteDecisionService) private readonly decisions: QuoteDecisionService) {}

  @Post(':id/aprovar')
  @HttpCode(200)
  approve(@Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() req: ClienteRequest) {
    return this.decide(id, body, key, req, 'APPROVED');
  }

  @Post(':id/recusar')
  @HttpCode(200)
  reject(@Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() req: ClienteRequest) {
    return this.decide(id, body, key, req, 'REJECTED');
  }

  private async decide(id: string, body: unknown, key: string | undefined, req: ClienteRequest, decision: Decision) {
    if (!id || id.length > 128 || typeof key !== 'string' || !key.trim() || key.length > 128 ||
        typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).some((field) => field !== 'versao') ||
        !('versao' in body) || !Number.isSafeInteger(body.versao) || (body.versao as number) < 1) throw new BadRequestException('Requisição inválida');
    const correlation = req.headers['x-correlation-id'];
    const correlationId = typeof correlation === 'string' && correlation.length <= 128 && correlation.trim() ? correlation : randomUUID();
    try {
      return await this.decisions.execute({ quoteId: id, clientId: req.clienteId!, version: body.versao as number, decision, idempotencyKey: key, correlationId });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message === 'Acesso negado') throw new ForbiddenException();
      if (message === 'Orçamento não encontrado') throw new NotFoundException();
      if (['Versão divergente', 'Decisão conflitante', 'Orçamento expirado', 'Conflito de concorrência', 'Chave de idempotência reutilizada com outra decisão'].includes(message)) throw new ConflictException(message);
      throw new ServiceUnavailableException('Não foi possível processar a decisão');
    }
  }
}
