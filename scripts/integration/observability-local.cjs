/* Teste sem acesso externo: recebe spans em um coletor HTTP local descartável. */
const http = require('node:http');
const { spawn } = require('node:child_process');
let traces = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/v1/traces' && req.method === 'POST') {
    let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; });
    req.on('end', () => { if (bytes) traces++; res.writeHead(200).end(); });
  } else res.writeHead(200).end('ok');
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const childCode = `const telemetry = require('./dist/infrastructure/observability/instrumentation').observability;
    const http = require('node:http');
    http.get('http://127.0.0.1:${port}/health', response => { response.resume(); response.on('end', () => { void telemetry.shutdown().then(() => process.exit(0), error => { console.error(error); process.exit(1); }); }); }).on('error', error => { console.error(error); process.exit(1); });`;
  const child = spawn(process.execPath, ['-e', childCode], { cwd: process.cwd(), env: { ...process.env, OBSERVABILITY_ENABLED: 'true', NEW_RELIC_LICENSE_KEY: 'local-test-only', OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}` }, stdio: 'inherit' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
  child.on('exit', code => { clearTimeout(timeout); server.close(() => { if (code !== 0 || !traces) { console.error('Teste de exportação OTLP local falhou'); process.exitCode = 1; } else console.log('Span exportado para coletor local.'); }); });
});
