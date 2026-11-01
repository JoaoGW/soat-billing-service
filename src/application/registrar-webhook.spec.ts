import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { RegisterMercadoPagoWebhook } from './registrar-webhook';

describe('RegisterMercadoPagoWebhook', () => {
  const secret = 'secret'; const dataId = 'ORD123'; const requestId = 'req'; const ts = '1234';
  const hash = createHmac('sha256', secret).update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex');
  const input = { dataId, requestId, signature: `ts=${ts},v1=${hash}`, body: { type: 'order', action: 'order.processed', data: { id: dataId, version: 2 } } };
  const receivedWebhook = { createMany: jest.fn() };
  const service = new RegisterMercadoPagoWebhook({ receivedWebhook } as unknown as PrismaClient, secret);
  beforeEach(() => { jest.resetAllMocks(); receivedWebhook.createMany.mockResolvedValue({ count: 1 }); });
  it('persiste a notificação assinada como recebida sem confirmar pagamento', async () => {
    await expect(service.execute(input)).resolves.toBe('RECORDED');
    expect(receivedWebhook.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true, data: [expect.objectContaining({ provider: 'mercado-pago-orders', payload: input.body, status: 'RECEIVED' })] }));
  });
  it('deduplica entrega equivalente com ordem diferente de campos', async () => {
    await service.execute(input);
    const first = receivedWebhook.createMany.mock.calls[0][0].data[0].eventId;
    receivedWebhook.createMany.mockResolvedValue({ count: 0 });
    await expect(service.execute({ ...input, body: { data: { version: 2, id: dataId }, action: 'order.processed', type: 'order' } })).resolves.toBe('DUPLICATE');
    expect(receivedWebhook.createMany.mock.calls[1][0].data[0].eventId).toBe(first);
  });
  it('não grava assinatura inválida nem id divergente', async () => {
    await expect(service.execute({ ...input, signature: 'invalid' })).rejects.toThrow('Assinatura');
    await expect(service.execute({ ...input, body: { ...input.body, data: { id: 'other' } } })).rejects.toThrow('Notificação');
    expect(receivedWebhook.createMany).not.toHaveBeenCalled();
  });
  it('propaga falha de banco para que o transporte não confirme', async () => {
    receivedWebhook.createMany.mockRejectedValue(new Error('database offline'));
    await expect(service.execute(input)).rejects.toThrow('database offline');
  });
});
