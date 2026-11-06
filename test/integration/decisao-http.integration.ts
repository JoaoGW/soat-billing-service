import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { QuoteDecisionService } from '../../src/application/decidir-orcamento';
import { QuoteQueryService } from '../../src/application/consultar-orcamento';
import { GenerateQuoteService } from '../../src/application/gerar-orcamento';
import { ClienteGuard } from '../../src/interfaces/cliente-guard';
import { OrcamentoController } from '../../src/interfaces/orcamento-controller';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL de teste é obrigatória');
const target = new URL(url);
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('A integração exige banco local com nome terminado em _test');

describe('decisão HTTP com PostgreSQL', () => {
  const prisma = new PrismaClient();
  const tag = randomUUID();
  let quoteId: string;
  const clientId = `http-client-${tag}`;
  const osId = `http-os-${tag}`;
  const secret = 'jwt-cliente-teste-com-mais-de-32-caracteres';
  let app: INestApplication;
  let previous: string | undefined;
  let previousIssuer: string | undefined;
  let previousAudience: string | undefined;
  const token = (subject: string) => jwt.sign({ role: 'cliente' }, secret, { subject, issuer: 'soat-auth-function', audience: 'soat-api', expiresIn: '15m' });
  const openapi = parse(readFileSync(resolve(process.cwd(), 'docs/openapi.yaml'), 'utf8')) as { components: { schemas: Record<string, object> } };
  const ajv = addFormats(new Ajv({ allErrors: true }));
  ajv.addKeyword('example');
  const validateQuote = ajv.compile(openapi.components.schemas.Quote);
  const validateDecision = ajv.compile(openapi.components.schemas.DecisionResult);

  beforeAll(async () => {
    previous = process.env.JWT_CLIENT_SECRET;
    previousIssuer = process.env.JWT_CLIENT_ISSUER;
    previousAudience = process.env.JWT_CLIENT_AUDIENCE;
    process.env.JWT_CLIENT_SECRET = secret;
    process.env.JWT_CLIENT_ISSUER = 'soat-auth-function';
    process.env.JWT_CLIENT_AUDIENCE = 'soat-api';
    const module = await Test.createTestingModule({ controllers: [OrcamentoController], providers: [ClienteGuard, { provide: QuoteDecisionService, useValue: new QuoteDecisionService(prisma) }, { provide: QuoteQueryService, useValue: new QuoteQueryService(prisma) }] }).compile();
    app = module.createNestApplication();
    await app.init();
    const created = await new GenerateQuoteService(prisma).execute({ messageId: `msg-${tag}`, operationId: `op-${tag}`, osId, sagaId: `saga-${tag}`, filialId: 'filial', correlationId: `corr-${tag}`, data: { clienteId: clientId, contato: 'cliente@example.test', diagnosisId: 'diag', diagnosisVersion: 1, expiresAt: new Date(Date.now() + 3600000).toISOString(), items: [{ sourceId: 'peca', itemType: 'PART', quantity: 1, unitPriceInCents: 1000 }] } });
    quoteId = created.quoteId;
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.JWT_CLIENT_SECRET; else process.env.JWT_CLIENT_SECRET = previous;
    if (previousIssuer === undefined) delete process.env.JWT_CLIENT_ISSUER; else process.env.JWT_CLIENT_ISSUER = previousIssuer;
    if (previousAudience === undefined) delete process.env.JWT_CLIENT_AUDIENCE; else process.env.JWT_CLIENT_AUDIENCE = previousAudience;
    await app.close();
    await prisma.$disconnect();
  });

  it('impede outro cliente e aprova apenas uma vez com a chave original', async () => {
    const endpoint = `/orcamentos/${quoteId}/aprovar`;
    await request(app.getHttpServer()).get(`/orcamentos/${quoteId}`).set('Authorization', `Bearer ${token('outro')}`).expect(403);
    const snapshot = await request(app.getHttpServer()).get(`/orcamentos/${quoteId}`).set('Authorization', `Bearer ${token(clientId)}`).expect(200);
    expect(snapshot.body).toMatchObject({ id: quoteId, totalInCents: 1000, currency: 'BRL' });
    expect(validateQuote(snapshot.body)).toBe(true);
    expect(snapshot.body).not.toHaveProperty('clientId');
    await request(app.getHttpServer()).post(endpoint).set('Authorization', `Bearer ${token('outro')}`).set('Idempotency-Key', 'key-1').send({ versao: 1 }).expect(403);
    const approved = await request(app.getHttpServer()).post(endpoint).set('Authorization', `Bearer ${token(clientId)}`).set('Idempotency-Key', 'key-1').send({ versao: 1 }).expect(200);
    expect(validateDecision(approved.body)).toBe(true);
    await request(app.getHttpServer()).post(endpoint).set('Authorization', `Bearer ${token(clientId)}`).set('Idempotency-Key', 'key-1').send({ versao: 1 }).expect(200);
    await request(app.getHttpServer()).post(`/orcamentos/${quoteId}/recusar`).set('Authorization', `Bearer ${token(clientId)}`).set('Idempotency-Key', 'key-2').send({ versao: 1 }).expect(409);
    expect(await prisma.quoteDecision.count({ where: { quoteId } })).toBe(1);
    const events = await prisma.outbox.findMany({ where: { payload: { path: ['osId'], equals: osId } } });
    expect(events.map((event) => event.type).sort()).toEqual(['billing.quote-approved.v1', 'billing.quote-issued.v1']);
  });
});
