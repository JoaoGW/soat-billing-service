import { propagation, trace, Tracer } from '@opentelemetry/api';
import { withMessageTrace } from './message-trace';

it('extrai contexto autenticado e encerra o span após sucesso ou erro', async () => {
  const span = { end: jest.fn(), setStatus: jest.fn() };
  const tracer = { startActiveSpan: (_name: string, _options: unknown, operation: (value: typeof span) => Promise<unknown>) => operation(span) };
  const tracerSpy = jest.spyOn(trace, 'getTracer').mockReturnValue(tracer as unknown as Tracer);
  const extractSpy = jest.spyOn(propagation, 'extract');
  try {
    await expect(withMessageTrace({ traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01', baggage: 'cpf=secret' }, async () => 'ok')).resolves.toBe('ok');
    expect(extractSpy).toHaveBeenCalledWith(expect.anything(), { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' });
    await expect(withMessageTrace(null, async () => { throw new Error('falha'); })).rejects.toThrow('falha');
    expect(span.end).toHaveBeenCalledTimes(2);
    expect(span.setStatus).toHaveBeenCalledTimes(1);
  } finally { tracerSpy.mockRestore(); extractSpy.mockRestore(); }
});
