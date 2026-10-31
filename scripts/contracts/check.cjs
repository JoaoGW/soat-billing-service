const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Ajv = require('ajv');

const dir = path.resolve(__dirname, '../../docs/contracts/messages');
const envelope = require(path.join(dir, 'envelope.schema.json'));
const schema = require(path.join(dir, 'billing.payment-confirmed.v1.schema.json'));
const example = require(path.join(dir, 'examples/billing.payment-confirmed.v1.json'));
const ajv = new Ajv({ allErrors: true, schemaId: 'auto' });
ajv.addSchema(envelope);
const validate = ajv.compile(schema);
assert.equal(validate(example), true, JSON.stringify(validate.errors));
for (const invalid of [
  { ...example, messageId: undefined },
  { ...example, producer: 'other-service' },
  { ...example, data: { ...example.data, currency: 'USD' } },
  { ...example, data: { ...example.data, amountInCents: 1.5 } },
  { ...example, data: { ...example.data, providerPaymentId: undefined } },
]) {
  assert.equal(validate(invalid), false, 'contrato inválido foi aceito');
}
console.log('Contrato payment-confirmed v1: exemplo e casos inválidos verificados.');
for (const filename of fs.readdirSync(dir).filter((name) => name.endsWith('.v1.schema.json') && name !== 'billing.payment-confirmed.v1.schema.json')) {
  const name = filename.replace('.schema.json', '');
  const contract = ajv.compile(require(path.join(dir, filename)));
  const fixture = require(path.join(dir, 'examples', `${name}.json`));
  assert.equal(contract(fixture), true, `${name}: ${JSON.stringify(contract.errors)}`);
  assert.equal(contract({ ...fixture, producer: 'servico-incorreto' }), false, `${name}: produtor inválido aceito`);
  assert.equal(contract({ ...fixture, data: {} }), false, `${name}: dados incompletos aceitos`);
  console.log(`${name}: exemplo e casos inválidos verificados.`);
}
