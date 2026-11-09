import { BadRequestException, Controller, Get, Inject, NotFoundException, Param, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ChargeQueryService } from '../application/consultar-cobranca';
import { ClienteGuard, ClienteRequest } from './cliente-guard';

@Controller('cobrancas')
@UseGuards(ClienteGuard)
export class CobrancaController {
  constructor(@Inject(ChargeQueryService) private readonly queries: ChargeQueryService) {}

  @Get('por-os/:osId')
  byOrder(@Param('osId') osId: string, @Req() request: ClienteRequest) { return this.query({ osId, clientId: request.clienteId! }); }

  @Get(':id')
  byId(@Param('id') id: string, @Req() request: ClienteRequest) { return this.query({ chargeId: id, clientId: request.clienteId! }); }

  private async query(input: { chargeId?: string; osId?: string; clientId: string }) {
    const id = input.chargeId ?? input.osId;
    if (!id || !/^[a-z0-9_-]{1,128}$/i.test(id)) throw new BadRequestException('Requisição inválida');
    try { return await this.queries.execute(input); }
    catch (error) {
      if (error instanceof Error && error.message === 'Cobrança não encontrada') throw new NotFoundException();
      throw new ServiceUnavailableException('Não foi possível consultar a cobrança');
    }
  }
}
