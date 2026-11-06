import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

/** Deve ser chamada após verificar a assinatura do produtor. */
export function withMessageTrace<T>(body: unknown, operation: () => Promise<T>): Promise<T> {
  const carrier: Record<string, string> = {};
  if (body && typeof body === 'object') {
    const envelope = body as { traceparent?: unknown; tracestate?: unknown };
    if (typeof envelope.traceparent === 'string') carrier.traceparent = envelope.traceparent;
    if (typeof envelope.tracestate === 'string') carrier.tracestate = envelope.tracestate;
  }
  const parent = propagation.extract(ROOT_CONTEXT, carrier);
  return context.with(parent, () => trace.getTracer('soat-messaging').startActiveSpan('processar mensagem', { kind: SpanKind.CONSUMER }, async span => {
    try { return await operation(); }
    catch (error) { span.setStatus({ code: SpanStatusCode.ERROR }); throw error; }
    finally { span.end(); }
  }));
}
