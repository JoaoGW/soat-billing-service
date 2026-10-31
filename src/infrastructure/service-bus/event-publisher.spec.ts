import { ServiceBusSender } from '@azure/service-bus';
import { ServiceBusEventPublisher } from './event-publisher';

describe('ServiceBusEventPublisher', () => {
  const sender = { sendMessages: jest.fn() };
  const publisher = new ServiceBusEventPublisher(sender as unknown as ServiceBusSender);
  beforeEach(() => jest.resetAllMocks());

  it('preserva ID, tipo e contexto de rastreamento', async () => {
    const payload = { messageId: 'm1', type: 'billing.quote-issued.v1', correlationId: 'c1', traceparent: 'trace', tracestate: 'state' };
    await publisher.publish({ messageId: 'm1', type: payload.type, payload });
    expect(sender.sendMessages).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm1', subject: payload.type, correlationId: 'c1', applicationProperties: { traceparent: 'trace', tracestate: 'state' }, body: payload }));
  });
  it('rejeita divergência entre o registro e o envelope', async () => {
    await expect(publisher.publish({ messageId: 'm1', type: 'event', payload: { messageId: 'm2', type: 'event' } })).rejects.toThrow('Envelope');
    expect(sender.sendMessages).not.toHaveBeenCalled();
  });
  it('propaga erro de envio para o retry da outbox', async () => {
    sender.sendMessages.mockRejectedValue(new Error('broker offline'));
    await expect(publisher.publish({ messageId: 'm1', type: 'event', payload: { messageId: 'm1', type: 'event' } })).rejects.toThrow('broker offline');
  });
});
