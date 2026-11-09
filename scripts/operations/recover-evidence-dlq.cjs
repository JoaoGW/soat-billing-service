const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { WorkloadIdentityCredential } = require('@azure/identity');
const { ServiceBusClient } = require('@azure/service-bus');
const { CompensationEvidenceConsumer, evidenceValidator } = require('../../dist/infrastructure/service-bus/compensation-evidence');
const { MessageVerifier } = require('../../dist/infrastructure/service-bus/message-signature');
const { RecoverBillingEvidenceDlq } = require('../../dist/infrastructure/service-bus/recover-evidence-dlq');

async function main() {
  const env = process.env;
  if (env.ENABLE_BILLING_EVIDENCE_DLQ_RECOVERY !== 'true' || !env.DATABASE_URL || !env.EXECUTION_MESSAGE_PUBLIC_KEY || !env.SERVICE_BUS_NAMESPACE || !/^[a-z0-9-]+\.servicebus\.windows\.net$/i.test(env.SERVICE_BUS_NAMESPACE) || !env.SERVICE_BUS_EVENT_TOPIC || !env.SERVICE_BUS_BILLING_EVIDENCE_SUBSCRIPTION || !env.AZURE_TENANT_ID || !env.AZURE_CLIENT_ID || !env.AZURE_FEDERATED_TOKEN_FILE || !env.BILLING_DLQ_MESSAGE_ID || !/^[a-z0-9_-]{1,128}$/i.test(env.BILLING_DLQ_MESSAGE_ID) || !env.BILLING_DLQ_ACTOR || !/^[a-z0-9_@.-]{1,128}$/i.test(env.BILLING_DLQ_ACTOR) || !env.BILLING_DLQ_REASON || !/^[A-Z0-9_]{3,80}$/.test(env.BILLING_DLQ_REASON)) throw new Error('Configuração incompleta');
  const database = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || !database.pathname || database.pathname === '/') throw new Error('Banco inválido');
  const verifier = new MessageVerifier(env.EXECUTION_MESSAGE_PUBLIC_KEY, 'soat-execution-service');
  const validate = evidenceValidator(path.resolve('docs/contracts/messages'));
  const db = new PrismaClient(); const bus = new ServiceBusClient(env.SERVICE_BUS_NAMESPACE, new WorkloadIdentityCredential());
  const receiver = bus.createReceiver(env.SERVICE_BUS_EVENT_TOPIC, env.SERVICE_BUS_BILLING_EVIDENCE_SUBSCRIPTION, { subQueueType: 'deadLetter', receiveMode: 'peekLock' });
  try {
    const messages = await receiver.receiveMessages(1, { maxWaitTimeInMs: 5000 });
    if (!messages.length) throw new Error('DLQ vazia');
    const message = messages[0]; let settlementAttempted = false;
    const settlement = { completeMessage: async item => { settlementAttempted = true; await receiver.completeMessage(item); } };
    try {
      const consumer = new CompensationEvidenceConsumer(db, verifier, validate);
      await new RecoverBillingEvidenceDlq(db, verifier, validate, consumer).execute(message, settlement, { messageId: env.BILLING_DLQ_MESSAGE_ID, actor: env.BILLING_DLQ_ACTOR, reasonCode: env.BILLING_DLQ_REASON });
      process.stdout.write('Evidência de cancelamento recuperada.\n');
    } catch (error) {
      if (!settlementAttempted) await receiver.abandonMessage(message);
      throw error;
    }
  } finally { try { await receiver.close(); } finally { try { await bus.close(); } finally { await db.$disconnect(); } } }
}
main().catch(() => { process.stderr.write('Recuperação recusada ou indisponível; consulte a configuração e a evidência selecionada.\n'); process.exitCode = 1; });
