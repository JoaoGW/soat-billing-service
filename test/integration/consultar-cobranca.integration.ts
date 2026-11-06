import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ChargeQueryService } from '../../src/application/consultar-cobranca';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { ClienteGuard } from '../../src/interfaces/cliente-guard';
import { CobrancaController } from '../../src/interfaces/cobranca-controller';

const url = process.env.DATABASE_URL;
if (!url || !['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname) || !new URL(url).pathname.endsWith('_test')) throw new Error('Banco local de teste obrigatório');

describe('isolamento da consulta de cobrança', () => {
  const db = new PrismaClient(); const service = new ChargeQueryService(db); const tag = randomUUID();
  const quoteId = `quote-${tag}`, chargeId = `charge-${tag}`, osId = `os-${tag}`, owner = `client-${tag}`;
  const original = { secret: process.env.JWT_CLIENT_SECRET, issuer: process.env.JWT_CLIENT_ISSUER, audience: process.env.JWT_CLIENT_AUDIENCE };
  const secret = 'jwt-cliente-teste-com-mais-de-32-caracteres';
  let app: INestApplication;
  beforeAll(async () => {
    Object.assign(process.env, { JWT_CLIENT_SECRET: secret, JWT_CLIENT_ISSUER: 'soat-auth-function', JWT_CLIENT_AUDIENCE: 'soat-api' });
    const module = await Test.createTestingModule({ controllers: [CobrancaController], providers: [ClienteGuard, { provide: ChargeQueryService, useValue: service }] }).compile();
    app = module.createNestApplication(); await app.init();
    await db.quote.create({ data: { id: quoteId, osId, sagaId: `saga-${tag}`, filialId: 'branch', clientId: owner, version: 1, totalInCents: 500, status: 'APPROVED', expiresAt: new Date('2099-01-01') } });
    await db.charge.create({ data: { id: chargeId, quoteId, osId, status: 'CREATED', amountInCents: 500, currency: 'BRL', externalReference: chargeId, expiresAt: new Date('2099-01-01'), attempts: { create: { id: `attempt-${tag}`, operationId: `op-${tag}`, providerKey: `key-${tag}`, status: 'CREATED', result: { qrData: 'test-qr', providerKey: 'do-not-expose' } } } } });
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries({ JWT_CLIENT_SECRET: original.secret, JWT_CLIENT_ISSUER: original.issuer, JWT_CLIENT_AUDIENCE: original.audience })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await app.close(); await db.$disconnect();
  });
  it('retorna QR somente ao proprietário por ID e por OS', async () => {
    expect(await service.execute({ chargeId, clientId: owner })).toMatchObject({ id: chargeId, qrData: 'test-qr' });
    expect(await service.execute({ osId, clientId: owner })).toMatchObject({ id: chargeId, qrData: 'test-qr' });
    await expect(service.execute({ chargeId, clientId: 'other' })).rejects.toThrow('Cobrança não encontrada');
    await expect(service.execute({ osId, clientId: 'other' })).rejects.toThrow('Cobrança não encontrada');
  });
  it('responde pela API conforme o contrato OpenAPI sem expor dados internos', async () => {
    const document = parse(readFileSync(resolve(process.cwd(), 'docs/openapi.yaml'), 'utf8')) as { components: { responses: { Charge: { content: { 'application/json': { schema: object } } } } } };
    const ajv = addFormats(new Ajv({ allErrors: true })); ajv.addKeyword('example');
    const validate = ajv.compile(document.components.responses.Charge.content['application/json'].schema);
    const token = jwt.sign({ role: 'cliente' }, secret, { subject: owner, issuer: 'soat-auth-function', audience: 'soat-api', expiresIn: '15m' });
    for (const path of [`/cobrancas/${chargeId}`, `/cobrancas/por-os/${osId}`]) {
      const response = await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`).expect(200);
      expect(validate(response.body)).toBe(true);
      expect(response.body.qrData).toBe('test-qr');
      expect(JSON.stringify(response.body)).not.toContain('do-not-expose');
    }
  });
});
