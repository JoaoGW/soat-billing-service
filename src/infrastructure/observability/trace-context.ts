import { context, propagation } from '@opentelemetry/api';
export function captureTrace(): { traceparent?: string; tracestate?: string } {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return { ...(carrier.traceparent ? { traceparent: carrier.traceparent } : {}), ...(carrier.tracestate ? { tracestate: carrier.tracestate } : {}) };
}
