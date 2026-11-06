import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';

export function startObservability(env: NodeJS.ProcessEnv = process.env): NodeSDK | undefined {
  if (env.OBSERVABILITY_ENABLED !== 'true') return undefined;
  if (!env.NEW_RELIC_LICENSE_KEY) throw new Error('NEW_RELIC_LICENSE_KEY é obrigatória quando observabilidade está habilitada');
  const endpoint = (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'https://otlp.nr-data.net:4318').replace(/\/$/, '');
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new Error('Endpoint OTLP inválido'); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) throw new Error('Endpoint OTLP deve usar HTTPS ou loopback local');
  const headers = { 'api-key': env.NEW_RELIC_LICENSE_KEY };
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': env.OTEL_SERVICE_NAME ?? 'soat-billing-service', 'service.version': env.OTEL_SERVICE_VERSION ?? 'local', 'deployment.environment.name': env.NODE_ENV ?? 'development' }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers }),
    metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics`, headers }), exportIntervalMillis: 30000 }),
    instrumentations: [getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-pg': { enhancedDatabaseReporting: false, requestHook: span => { span.setAttribute('db.query.text', '[redacted]'); span.setAttribute('db.statement', '[redacted]'); } },
      '@opentelemetry/instrumentation-http': { requestHook: span => { span.setAttribute('url.full', '[redacted]'); span.setAttribute('url.path', '[redacted]'); span.setAttribute('url.query', '[redacted]'); span.setAttribute('http.url', '[redacted]'); span.setAttribute('http.target', '[redacted]'); } },
    })],
  });
  sdk.start();
  return sdk;
}

// Carregado antes de Nest e dos clients para permitir a instrumentação automática.
export const observability = startObservability();
