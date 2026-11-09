const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats').default;
const { PrismaClient } = require('@prisma/client');
const { RecoverBillingOutbox } = require('../../dist/application/recuperar-outbox');

const allowed = [
  'billing.quote-issued.v1', 'billing.quote-failed.v1', 'billing.quote-approved.v1',
  'billing.quote-rejected.v1', 'billing.charge-created.v1', 'billing.charge-failed.v1',
  'billing.payment-confirmed.v1', 'billing.payment-refunded.v1', 'billing.refund-blocked.v1',
];

async function main() {
  if (process.env.ENABLE_BILLING_OUTBOX_RECOVERY !== 'true' || !process.env.DATABASE_URL) throw new Error('Recuperação não habilitada');
  const directory = path.resolve(__dirname, '../../docs/contracts/messages');
  const ajv = addFormats(new Ajv({ allErrors: true }));
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(directory, 'envelope.schema.json'), 'utf8')));
  const validators = new Map(allowed.map(type => [type, ajv.compile(JSON.parse(fs.readFileSync(path.join(directory, `${type}.schema.json`), 'utf8')))]));
  const db = new PrismaClient();
  try {
    const recovery = new RecoverBillingOutbox(db, (type, payload) => validators.get(type)?.(payload) === true);
    const auditId = await recovery.execute({ messageId: process.env.BILLING_RECOVERY_MESSAGE_ID, actor: process.env.BILLING_RECOVERY_ACTOR, reasonCode: process.env.BILLING_RECOVERY_REASON });
    process.stdout.write(`Evento rearmado; auditoria ${auditId}\n`);
  } finally { await db.$disconnect(); }
}

main().catch(() => { process.stderr.write('Recuperação recusada ou indisponível; consulte a configuração e o estado do evento.\n'); process.exitCode = 1; });
