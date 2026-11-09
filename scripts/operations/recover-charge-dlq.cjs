const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats').default;
const { PrismaClient } = require('@prisma/client');
const { WorkloadIdentityCredential } = require('@azure/identity');
const { ServiceBusClient } = require('@azure/service-bus');
const { createChargeCommandValidator } = require('../../dist/infrastructure/service-bus/charge-consumer');
const { MessageVerifier } = require('../../dist/infrastructure/service-bus/message-signature');
const { RecoverBillingChargeDlq } = require('../../dist/infrastructure/service-bus/recover-charge-dlq');
async function main() {
  const env = process.env;
  if (env.ENABLE_BILLING_CHARGE_DLQ_RECOVERY !== 'true' || !env.DATABASE_URL || !env.OS_MESSAGE_PUBLIC_KEY || !env.SERVICE_BUS_NAMESPACE || !/^[a-z0-9-]+\.servicebus\.windows\.net$/i.test(env.SERVICE_BUS_NAMESPACE) || !env.SERVICE_BUS_COMMAND_QUEUE || !env.AZURE_TENANT_ID || !env.AZURE_CLIENT_ID || !env.AZURE_FEDERATED_TOKEN_FILE || !env.BILLING_DLQ_MESSAGE_ID || !/^[a-z0-9_-]{1,128}$/i.test(env.BILLING_DLQ_MESSAGE_ID) || !env.BILLING_DLQ_ACTOR || !/^[a-z0-9_@.-]{1,128}$/i.test(env.BILLING_DLQ_ACTOR) || !env.BILLING_DLQ_REASON || !/^[A-Z0-9_]{3,80}$/.test(env.BILLING_DLQ_REASON)) throw new Error('Configuração incompleta');
  const database = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || !database.pathname || database.pathname === '/') throw new Error('Banco inválido');
  const directory = path.resolve('docs/contracts/messages'); const ajv = addFormats(new Ajv({ allErrors: true }));
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(directory, 'envelope.schema.json'), 'utf8')));
  const validators = new Map(['billing.charge-created.v1', 'billing.charge-failed.v1'].map(type => [type, ajv.compile(JSON.parse(fs.readFileSync(path.join(directory, `${type}.schema.json`), 'utf8')))]));
  const verifier = new MessageVerifier(env.OS_MESSAGE_PUBLIC_KEY, 'soat-os-service');
  const db = new PrismaClient(); const bus = new ServiceBusClient(env.SERVICE_BUS_NAMESPACE, new WorkloadIdentityCredential());
  const receiver = bus.createReceiver(env.SERVICE_BUS_COMMAND_QUEUE, { subQueueType: 'deadLetter', receiveMode: 'peekLock' });
  try {
    const messages = await receiver.receiveMessages(1, { maxWaitTimeInMs: 5000 });
    if (!messages.length) throw new Error('DLQ vazia');
    const message = messages[0]; let settlementAttempted = false;
    const settlement = { completeMessage: async item => { settlementAttempted = true; await receiver.completeMessage(item); } };
    try {
      const recovery = new RecoverBillingChargeDlq(db, verifier, createChargeCommandValidator(directory), (type, body) => validators.get(type)?.(body) === true);
      await recovery.execute(message, settlement, { messageId: env.BILLING_DLQ_MESSAGE_ID, actor: env.BILLING_DLQ_ACTOR, reasonCode: env.BILLING_DLQ_REASON });
      process.stdout.write('Resultado existente de cobrança comprovado.\n');
    } catch (error) {
      if (!settlementAttempted) await receiver.abandonMessage(message);
      throw error;
    }
  } finally { try { await receiver.close(); } finally { try { await bus.close(); } finally { await db.$disconnect(); } } }
}
main().catch(() => { process.stderr.write('Recuperação recusada ou indisponível; confira o resultado financeiro e a mensagem selecionada.\n'); process.exitCode = 1; });
