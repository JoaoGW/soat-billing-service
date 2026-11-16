import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { startObservability } from './instrumentation';

jest.mock('@opentelemetry/auto-instrumentations-node', () => ({ getNodeAutoInstrumentations: jest.fn(() => []) }));
jest.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({ OTLPTraceExporter: jest.fn() }));
jest.mock('@opentelemetry/exporter-metrics-otlp-proto', () => ({ OTLPMetricExporter: jest.fn() }));
jest.mock('@opentelemetry/resources', () => ({ resourceFromAttributes: jest.fn(() => ({})) }));
jest.mock('@opentelemetry/sdk-metrics', () => ({ PeriodicExportingMetricReader: jest.fn() }));
jest.mock('@opentelemetry/sdk-node', () => ({ NodeSDK: jest.fn().mockImplementation(() => ({ start: jest.fn() })) }));

describe('observabilidade do Billing', () => {
  beforeEach(() => jest.clearAllMocks());
  it('permanece desabilitada sem configuração e rejeita ativação sem chave', () => {
    expect(startObservability({})).toBeUndefined();
    expect(() => startObservability({ OBSERVABILITY_ENABLED: 'true' })).toThrow('NEW_RELIC_LICENSE_KEY');
    expect(() => startObservability({ OBSERVABILITY_ENABLED: 'true', NEW_RELIC_LICENSE_KEY: 'x', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://example.com' })).toThrow('HTTPS');
    expect(() => startObservability({ OBSERVABILITY_ENABLED: 'true', NEW_RELIC_LICENSE_KEY: 'x', OTEL_EXPORTER_OTLP_ENDPOINT: 'invalid' })).toThrow('inválido');
    expect(NodeSDK).not.toHaveBeenCalled();
  });
  it('envia ao Collector do ambiente local sem chave somente com ALLOW_LOCAL_EMULATORS', () => {
    expect(() => startObservability({ OBSERVABILITY_ENABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318' })).toThrow('NEW_RELIC_LICENSE_KEY');
    expect(() => startObservability({ OBSERVABILITY_ENABLED: 'true', NEW_RELIC_LICENSE_KEY: 'x', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318' })).toThrow('HTTPS');
    startObservability({ OBSERVABILITY_ENABLED: 'true', ALLOW_LOCAL_EMULATORS: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318/' });
    expect(OTLPTraceExporter).toHaveBeenCalledWith({ url: 'http://otel-collector:4318/v1/traces', headers: {} });
  });
  it('configura serviço, exportação e ocultação de dados em HTTP e SQL', () => {
    const sdk = startObservability({ OBSERVABILITY_ENABLED: 'true', NEW_RELIC_LICENSE_KEY: 'test-key', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.test/', OTEL_SERVICE_VERSION: 'sha-test', NODE_ENV: 'test' });
    expect(resourceFromAttributes).toHaveBeenCalledWith(expect.objectContaining({ 'service.name': 'soat-billing-service', 'service.version': 'sha-test' }));
    expect(OTLPTraceExporter).toHaveBeenCalledWith({ url: 'https://collector.test/v1/traces', headers: { 'api-key': 'test-key' } });
    expect(sdk?.start).toHaveBeenCalled();
    const options = jest.mocked(getNodeAutoInstrumentations).mock.calls[0][0] as unknown as Record<string, { requestHook: (span: { setAttribute: jest.Mock; updateName: jest.Mock }) => void }>;
    const span = { setAttribute: jest.fn(), updateName: jest.fn() };
    options['@opentelemetry/instrumentation-http'].requestHook(span);
    options['@opentelemetry/instrumentation-pg'].requestHook(span);
    expect(span.setAttribute).toHaveBeenCalledWith('url.query', '[redacted]');
    expect(span.setAttribute).toHaveBeenCalledWith('db.query.text', '[redacted]');
    expect(span.updateName).toHaveBeenCalledWith('HTTP request');
    expect(span.updateName).toHaveBeenCalledWith('PostgreSQL query');
  });
});
