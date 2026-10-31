import { ServiceBusMessage, ServiceBusSender } from '@azure/service-bus';
import { MessagePublisher } from '../../application/publicar-outbox';

export class ServiceBusEventPublisher implements MessagePublisher {
  constructor(private readonly sender: Pick<ServiceBusSender, 'sendMessages'>) {}

  async publish(message: { messageId: string; type: string; payload: unknown }): Promise<void> {
    const payload = message.payload;
    if (!payload || typeof payload !== 'object' || !('messageId' in payload) || !('type' in payload) ||
        payload.messageId !== message.messageId || payload.type !== message.type) throw new Error('Envelope da outbox inválido');
    const correlationId = 'correlationId' in payload && typeof payload.correlationId === 'string' ? payload.correlationId : undefined;
    const traceparent = 'traceparent' in payload && typeof payload.traceparent === 'string' ? payload.traceparent : undefined;
    const tracestate = 'tracestate' in payload && typeof payload.tracestate === 'string' ? payload.tracestate : undefined;
    const event: ServiceBusMessage = {
      messageId: message.messageId, subject: message.type, contentType: 'application/json', correlationId,
      body: payload,
      applicationProperties: { ...(traceparent ? { traceparent } : {}), ...(tracestate ? { tracestate } : {}) },
    };
    await this.sender.sendMessages(event);
  }
}
