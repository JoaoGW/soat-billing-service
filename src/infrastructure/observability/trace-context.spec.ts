import { context, propagation, ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { captureTrace } from './trace-context';

it('captura o contexto W3C ativo sem propagar baggage', () => {
  const manager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(manager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  try {
    const active = trace.setSpanContext(ROOT_CONTEXT, { traceId: '0123456789abcdef0123456789abcdef', spanId: '0123456789abcdef', traceFlags: TraceFlags.SAMPLED });
    expect(context.with(active, captureTrace)).toEqual({ traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' });
    expect(captureTrace()).toEqual({});
  } finally { propagation.disable(); context.disable(); manager.disable(); }
});
