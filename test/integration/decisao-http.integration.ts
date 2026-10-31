import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { QuoteDecisionService } from '../../src/application/decidir-orcamento';
import { ClienteGuard } from '../../src/interfaces/cliente-guard';
import { OrcamentoController } from '../../src/interfaces/orcamento-controller';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL de teste é obrigatória');
const target = new URL(url);
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('A integração exige banco local com nome terminado em _test');

describe('decisão HTTP com PostgreSQL', () => {
  const prisma = new PrismaClient();
  const tag = randomUUID();
  const quoteId = `http-quote-${tag}`;
  const clientId = `http-client-${tag}`;
  const osId = `http-os-${tag}`;
  const secret = 'jwt-cliente-teste-com-mais-de-32-caracteres';
  let app: INestApplication;
  let previous: string | undefined;
  const token = (subject: string) => jwt.sign({ role: 'cliente' }, secret, { subject, issuer: 'soat-auth-function', audience: 'soat-api', expiresIn: '15m' });

  beforeAll(async () => {
    previous = process.env.JWT_CLIENT_SECRET;
    process.env.JWT_CLIENT_SECRET = secret;
    const module = await Test.createTestingModule({ controllers: [OrcamentoController], providers: [ClienteGuard, { provide: QuoteDecisionService, useValue: new QuoteDecisionService(prisma) }] }).compile();
    app = module.createNestApplication();
    await app.init();
    await prisma.quote.create({ data: { id: quoteId, osId, sagaId: `saga-${tag}`, filialId: 'filial', clientId, version: 1, totalInCents: 1000, status: 'ISSUED', expiresAt: new Date(Date.now() + 3600000) } });
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.JWT_CLIENT_SECRET; else process.env.JWT_CLIENT_SECRET = previous;
    await app.close();
    await prisma.$disconnect();
  });

  it('impede outro cliente e aprova apenas uma vez com a chave original', async () => {
    const endpoint = `/orcamentos/${quoteId}/aprovar`;
    await request(app.getHttpServer()).post(endpoint).set('Authorization', `Bearer ${token('outro')}`).set('Idempotency-Key', 'key-1').send({ versao: 1 }).expect(403);
    await request(app.getHttpServer()).post(endpoint).set('Authorization', `Bearer ${token(clientId)}`).set('Idempotency-Key', 'key-1').send({ versao: 1 }).expect(200);
    await request(app.getHttpServer()).post(endpoint).set('Authorization', `Bearer ${token(clientId)}`).set('Idempotency-Key', 'key-1').send({ versao: 1 }).expect(200);
    await request(app.getHttpServer()).post(`/orcamentos/${quoteId}/recusar`).set('Authorization', `Bearer ${token(clientId)}`).set('Idempotency-Key', 'key-2').send({ versao: 1 }).expect(409);
    expect(await prisma.quoteDecision.count({ where: { quoteId } })).toBe(1);
    expect(await prisma.outbox.count({ where: { payload: { path: ['osId'], equals: osId } } })).toBe(1);
  });
});
