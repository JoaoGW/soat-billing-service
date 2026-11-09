import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { ChargeQueryService } from '../application/consultar-cobranca';
import { ClienteGuard } from './cliente-guard';
import { CobrancaController } from './cobranca-controller';

describe('consulta autenticada de cobranças', () => {
  const secret = 'jwt-cliente-de-teste-com-mais-de-32-bytes'; const queries = { execute: jest.fn() }; let app: INestApplication; const original = process.env;
  beforeAll(async () => { process.env = { ...original, JWT_CLIENT_SECRET: secret, JWT_CLIENT_ISSUER: 'soat-auth-function', JWT_CLIENT_AUDIENCE: 'soat-api' }; const module = await Test.createTestingModule({ controllers: [CobrancaController], providers: [ClienteGuard, { provide: ChargeQueryService, useValue: queries }] }).compile(); app = module.createNestApplication(); await app.init(); });
  afterAll(async () => { process.env = original; await app.close(); });
  beforeEach(() => { jest.resetAllMocks(); });
  const token = jwt.sign({ role: 'cliente' }, secret, { subject: 'client-1', issuer: 'soat-auth-function', audience: 'soat-api', expiresIn: '15m' });
  it('exige JWT de cliente', async () => { await request(app.getHttpServer()).get('/cobrancas/id-1').expect(401); expect(queries.execute).not.toHaveBeenCalled(); });
  it('usa o cliente do JWT em ambas as rotas', async () => {
    queries.execute.mockResolvedValue({ id: 'id-1', amountInCents: 1000 });
    await request(app.getHttpServer()).get('/cobrancas/id-1').set('Authorization', `Bearer ${token}`).expect(200);
    expect(queries.execute).toHaveBeenCalledWith({ chargeId: 'id-1', clientId: 'client-1' });
    await request(app.getHttpServer()).get('/cobrancas/por-os/os-1').set('Authorization', `Bearer ${token}`).expect(200);
    expect(queries.execute).toHaveBeenCalledWith({ osId: 'os-1', clientId: 'client-1' });
  });
  it('retorna 404 sem revelar se a cobrança pertence a outra pessoa', async () => { queries.execute.mockRejectedValue(new Error('Cobrança não encontrada')); await request(app.getHttpServer()).get('/cobrancas/id-1').set('Authorization', `Bearer ${token}`).expect(404); });
  it('protege falhas internas', async () => { queries.execute.mockRejectedValue(new Error('secret')); const response = await request(app.getHttpServer()).get('/cobrancas/id-1').set('Authorization', `Bearer ${token}`).expect(503); expect(JSON.stringify(response.body)).not.toContain('secret'); });
});
