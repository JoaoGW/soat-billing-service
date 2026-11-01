import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrepareChargeService } from '../../src/application/preparar-cobranca';
import { SubmitChargeService } from '../../src/application/enviar-cobranca';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL de teste é obrigatória');
const target = new URL(url);
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('A integração exige banco local com nome terminado em _test');

describe('envio de cobrança com intenção durável', () => {
  const prisma = new PrismaClient(); const prepare = new PrepareChargeService(prisma);
  const tag = randomUUID(); const now = new Date('2030-01-01T00:00:00Z');
  const input = { operationId: `op-${tag}`, chargeId: `ch-${tag}`, quoteId: `q-${tag}`, quoteVersion: 1, osId: `os-${tag}`, sagaId: `s-${tag}`, filialId: 'branch', externalPosId: 'pos', expiresAt: '2030-01-01T00:15:00Z' };
  beforeAll(async () => {
    await prisma.quote.create({ data: { id: input.quoteId, osId: input.osId, sagaId: input.sagaId, filialId: input.filialId, clientId: 'client', version: 1, totalInCents: 5123, status: 'APPROVED', expiresAt: new Date('2030-01-02') } });
    await prepare.execute(input, now);
  });
  afterAll(async () => { await prisma.$disconnect(); });
  it('só uma concorrente chama o provedor e as demais não reenviam', async () => {
    let entered!: () => void; let release!: () => void;
    const sending = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const provider = { create: jest.fn(async () => { entered(); await wait; return { id: `ORD${'A'.repeat(26)}`, type: 'qr', external_reference: input.chargeId, currency: 'BRL', total_amount: '51.23', status: 'created', type_response: { qr_data: 'qr-test' } }; }) };
    const service = new SubmitChargeService(prisma, provider);
    const first = service.execute(input.operationId, now);
    await sending;
    try {
      await expect(service.execute(input.operationId, now)).resolves.toBe('IN_FLIGHT');
      expect(provider.create).toHaveBeenCalledTimes(1);
    } finally { release(); }
    await expect(first).resolves.toBe('CREATED');
    await expect(service.execute(input.operationId, now)).resolves.toBe('CREATED');
    expect(await prisma.charge.findUniqueOrThrow({ where: { id: input.chargeId } })).toMatchObject({ status: 'CREATED', providerOrderId: `ORD${'A'.repeat(26)}` });
  });
});
