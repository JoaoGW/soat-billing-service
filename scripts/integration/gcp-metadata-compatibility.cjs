/* Verifica a compatibilidade do transporte transitivo sem acessar GCP. */
const http = require('node:http');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const server = http.createServer((request, response) => {
  if (request.headers['metadata-flavor'] !== 'Google') { response.writeHead(400); response.end(); return; }
  response.setHeader('metadata-flavor', 'Google');
  if (request.url === '/computeMetadata/v1/instance') { response.end('local'); return; }
  if (request.url === '/computeMetadata/v1/instance/id') { response.end('local-instance'); return; }
  response.writeHead(404); response.end('not found');
});
server.listen(0, '127.0.0.1', async () => {
  try {
    process.env.GCE_METADATA_HOST = `http://127.0.0.1:${server.address().port}`;
    delete process.env.GCE_METADATA_IP;
    process.env.METADATA_SERVER_DETECTION = 'ping-only';
    const metadata = createRequire(require.resolve('@opentelemetry/resource-detector-gcp'))('gcp-metadata');
    assert.equal(await metadata.isAvailable(), true);
    assert.equal(await metadata.instance('id'), 'local-instance');
    await assert.rejects(metadata.instance('missing'), error => error.response?.status === 404);
    process.stdout.write('Compatibilidade dos metadados verificada em loopback.\n');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { server.close(); }
});
