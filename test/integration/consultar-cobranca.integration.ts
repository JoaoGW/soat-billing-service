import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ChargeQueryService } from '../../src/application/consultar-cobranca';

const url = process.env.DATABASE_URL;
if (!url || !['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname) || !new URL(url).pathname.endsWith('_test')) throw new Error('Banco local de teste obrigatório');

describe('isolamento da consulta de cobrança', () => {
  const db = new PrismaClient(); const service = new ChargeQueryService(db); const tag = randomUUID();
  const quoteId = `quote-${tag}`, chargeId = `charge-${tag}`, osId = `os-${tag}`, owner = `client-${tag}`;
  beforeAll(async () => {
    await db.quote.create({ data: { id: quoteId, osId, sagaId: `saga-${tag}`, filialId: 'branch', clientId: owner, version: 1, totalInCents: 500, status: 'APPROVED', expiresAt: new Date('2099-01-01') } });
    await db.charge.create({ data: { id: chargeId, quoteId, osId, status: 'CREATED', amountInCents: 500, currency: 'BRL', externalReference: chargeId, expiresAt: new Date('2099-01-01'), attempts: { create: { id: `attempt-${tag}`, operationId: `op-${tag}`, providerKey: `key-${tag}`, status: 'CREATED', result: { qrData: 'test-qr', providerKey: 'do-not-expose' } } } } });
  });
  afterAll(async () => { await db.$disconnect(); });
  it('retorna QR somente ao proprietário por ID e por OS', async () => {
    expect(await service.execute({ chargeId, clientId: owner })).toMatchObject({ id: chargeId, qrData: 'test-qr' });
    expect(await service.execute({ osId, clientId: owner })).toMatchObject({ id: chargeId, qrData: 'test-qr' });
    await expect(service.execute({ chargeId, clientId: 'other' })).rejects.toThrow('Cobrança não encontrada');
    await expect(service.execute({ osId, clientId: 'other' })).rejects.toThrow('Cobrança não encontrada');
  });
});
