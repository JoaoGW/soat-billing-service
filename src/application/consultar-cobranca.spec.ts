import { PrismaClient } from '@prisma/client';
import { ChargeQueryService } from './consultar-cobranca';

describe('consulta de cobrança', () => {
  const db = { charge: { findFirst: jest.fn() } }; const query = new ChargeQueryService(db as unknown as PrismaClient);
  const now = new Date('2030-01-01T00:00:00Z');
  const record = { id: 'c', osId: 'os', quoteId: 'q', status: 'CREATED', amountInCents: 1000, currency: 'BRL', expiresAt: new Date('2030-01-01T00:15:00Z'), attempts: [{ result: { qrData: 'qr', providerKey: 'secret', fingerprint: 'internal' } }] };
  beforeEach(() => { jest.resetAllMocks(); db.charge.findFirst.mockResolvedValue(record); });
  it('filtra proprietário e retorna apenas dados públicos e QR válido', async () => {
    await expect(query.execute({ chargeId: 'c', clientId: 'client' }, now)).resolves.toEqual({ id: 'c', osId: 'os', quoteId: 'q', status: 'CREATED', amountInCents: 1000, currency: 'BRL', expiresAt: record.expiresAt, qrData: 'qr' });
    expect(db.charge.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c', quote: { clientId: 'client' } } }));
  });
  it('não fornece QR de cobrança expirada ou paga e usa a ordem recente', async () => {
    expect(await query.execute({ osId: 'os', clientId: 'client' }, new Date('2030-01-01T00:15:00Z'))).not.toHaveProperty('qrData');
    expect(db.charge.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { osId: 'os', quote: { clientId: 'client' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }));
    db.charge.findFirst.mockResolvedValueOnce({ ...record, status: 'PAID' });
    expect(await query.execute({ chargeId: 'c', clientId: 'client' }, now)).not.toHaveProperty('qrData');
  });
  it('recusa consultas inválidas e cobrança de outro cliente', async () => {
    await expect(query.execute({ clientId: 'client' }, now)).rejects.toThrow('Consulta inválida');
    await expect(query.execute({ chargeId: 'c', osId: 'os', clientId: 'client' }, now)).rejects.toThrow('Consulta inválida');
    db.charge.findFirst.mockResolvedValueOnce(null);
    await expect(query.execute({ chargeId: 'c', clientId: 'outro' }, now)).rejects.toThrow('Cobrança não encontrada');
  });
});
