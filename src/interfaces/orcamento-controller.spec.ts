import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { QuoteDecisionService } from '../application/decidir-orcamento';
import { QuoteQueryService } from '../application/consultar-orcamento';
import { ClienteGuard } from './cliente-guard';
import { OrcamentoController } from './orcamento-controller';

describe('decisão autenticada de orçamento', () => {
  const secret = 'jwt-cliente-de-teste-com-mais-de-32-bytes';
  const decisions = { execute: jest.fn() };
  const queries = { execute: jest.fn() };
  let app: INestApplication;
  let previousSecret: string | undefined;
  let previousIssuer: string | undefined;
  let previousAudience: string | undefined;
  beforeAll(async () => {
    previousSecret = process.env.JWT_CLIENT_SECRET;
    previousIssuer = process.env.JWT_CLIENT_ISSUER;
    previousAudience = process.env.JWT_CLIENT_AUDIENCE;
    process.env.JWT_CLIENT_SECRET = secret;
    process.env.JWT_CLIENT_ISSUER = 'soat-auth-function';
    process.env.JWT_CLIENT_AUDIENCE = 'soat-api';
    const module = await Test.createTestingModule({ controllers: [OrcamentoController], providers: [ClienteGuard, { provide: QuoteDecisionService, useValue: decisions }, { provide: QuoteQueryService, useValue: queries }] }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    if (previousSecret === undefined) delete process.env.JWT_CLIENT_SECRET; else process.env.JWT_CLIENT_SECRET = previousSecret;
    if (previousIssuer === undefined) delete process.env.JWT_CLIENT_ISSUER; else process.env.JWT_CLIENT_ISSUER = previousIssuer;
    if (previousAudience === undefined) delete process.env.JWT_CLIENT_AUDIENCE; else process.env.JWT_CLIENT_AUDIENCE = previousAudience;
    await app.close();
  });
  beforeEach(() => { jest.resetAllMocks(); decisions.execute.mockResolvedValue({ quoteId: 'quote-1', version: 1, decision: 'APPROVED' }); });
  const sign = (role = 'cliente', issuer = 'soat-auth-function') => jwt.sign({ role }, secret, { subject: 'cliente-1', issuer, audience: 'soat-api', expiresIn: '15m' });

  it('exige JWT cliente válido com issuer, audience e expiração', async () => {
    const withoutExpiry = jwt.sign({ role: 'cliente' }, secret, { subject: 'cliente-1', issuer: 'soat-auth-function', audience: 'soat-api' });
    for (const token of [sign('admin'), sign('cliente', 'issuer-errado'), withoutExpiry, 'invalido']) {
      await request(app.getHttpServer()).post('/orcamentos/quote-1/aprovar').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'key1').send({ versao: 1 }).expect(401);
    }
    await request(app.getHttpServer()).post('/orcamentos/quote-1/aprovar').send({ versao: 1 }).expect(401);
    expect(decisions.execute).not.toHaveBeenCalled();
  });
  it('extrai cliente do JWT e passa versão e chave para o serviço', async () => {
    await request(app.getHttpServer()).post('/orcamentos/quote-1/aprovar').set('Authorization', `Bearer ${sign()}`).set('Idempotency-Key', 'key1').send({ versao: 1 }).expect(200);
    expect(decisions.execute).toHaveBeenCalledWith(expect.objectContaining({ quoteId: 'quote-1', clientId: 'cliente-1', version: 1, decision: 'APPROVED', idempotencyKey: 'key1' }));
  });
  it('consulta o orçamento com identidade obtida do JWT', async () => {
    queries.execute.mockResolvedValue({ id: 'quote-1', totalInCents: 100 });
    const response = await request(app.getHttpServer()).get('/orcamentos/quote-1').set('Authorization', `Bearer ${sign()}`).expect(200);
    expect(response.body).toEqual({ id: 'quote-1', totalInCents: 100 });
    expect(queries.execute).toHaveBeenCalledWith('quote-1', 'cliente-1');
  });
  it.each([['Acesso negado', 403], ['Orçamento não encontrado', 404], ['erro técnico', 503]])('protege erro de consulta %s', async (message, status) => {
    queries.execute.mockRejectedValue(new Error(message));
    await request(app.getHttpServer()).get('/orcamentos/quote-1').set('Authorization', `Bearer ${sign()}`).expect(status);
  });
  it('recusa campos adicionais e solicitações sem chave', async () => {
    await request(app.getHttpServer()).post('/orcamentos/quote-1/recusar').set('Authorization', `Bearer ${sign()}`).set('Idempotency-Key', 'key1').send({ versao: 1, clienteId: 'outro' }).expect(400);
    await request(app.getHttpServer()).post('/orcamentos/quote-1/recusar').set('Authorization', `Bearer ${sign()}`).send({ versao: 1 }).expect(400);
    expect(decisions.execute).not.toHaveBeenCalled();
  });
  it.each([['Acesso negado', 403], ['Orçamento não encontrado', 404], ['Decisão conflitante', 409], ['erro técnico', 503]])('traduz erro %s sem expor detalhes técnicos', async (message, status) => {
    decisions.execute.mockRejectedValue(new Error(message));
    const response = await request(app.getHttpServer()).post('/orcamentos/quote-1/recusar').set('Authorization', `Bearer ${sign()}`).set('Idempotency-Key', 'key1').send({ versao: 1 }).expect(status);
    if (status === 503) expect(JSON.stringify(response.body)).not.toContain('erro técnico');
  });
});
