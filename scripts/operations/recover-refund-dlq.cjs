const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { WorkloadIdentityCredential } = require('@azure/identity');
const { ServiceBusClient } = require('@azure/service-bus');
const { RefundCommandConsumer, refundCommandValidator } = require('../../dist/infrastructure/service-bus/refund-command');
const { MessageVerifier } = require('../../dist/infrastructure/service-bus/message-signature');
const { RecoverBillingRefundDlq } = require('../../dist/infrastructure/service-bus/recover-refund-dlq');
async function main() {
  const env = process.env;
  if (env.ENABLE_BILLING_REFUND_DLQ_RECOVERY !== 'true' || !env.DATABASE_URL || !env.OS_MESSAGE_PUBLIC_KEY || !env.SERVICE_BUS_NAMESPACE || !/^[a-z0-9-]+\.servicebus\.windows\.net$/i.test(env.SERVICE_BUS_NAMESPACE) || !env.SERVICE_BUS_COMMAND_QUEUE || !env.AZURE_TENANT_ID || !env.AZURE_CLIENT_ID || !env.AZURE_FEDERATED_TOKEN_FILE || !env.BILLING_DLQ_MESSAGE_ID || !/^[a-z0-9_-]{1,128}$/i.test(env.BILLING_DLQ_MESSAGE_ID) || !env.BILLING_DLQ_ACTOR || !/^[a-z0-9_@.-]{1,128}$/i.test(env.BILLING_DLQ_ACTOR) || !env.BILLING_DLQ_REASON || !/^[A-Z0-9_]{3,80}$/.test(env.BILLING_DLQ_REASON)) throw new Error('Configuração incompleta');
  const database = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || !database.pathname || database.pathname === '/') throw new Error('Banco inválido');
  const verifier = new MessageVerifier(env.OS_MESSAGE_PUBLIC_KEY, 'soat-os-service');
  const validate = refundCommandValidator(path.resolve('docs/contracts/messages'));
  const db = new PrismaClient(); const bus = new ServiceBusClient(env.SERVICE_BUS_NAMESPACE, new WorkloadIdentityCredential());
  const receiver = bus.createReceiver(env.SERVICE_BUS_COMMAND_QUEUE, { subQueueType: 'deadLetter', receiveMode: 'peekLock' });
  try {
    const messages = await receiver.receiveMessages(1, { maxWaitTimeInMs: 5000 });
    if (!messages.length) throw new Error('DLQ vazia');
    const message = messages[0]; let settlementAttempted = false;
    const settlement = { completeMessage: async item => { settlementAttempted = true; await receiver.completeMessage(item); } };
    try {
      await new RecoverBillingRefundDlq(db, verifier, validate, new RefundCommandConsumer(db, validate)).execute(message, settlement, { messageId: env.BILLING_DLQ_MESSAGE_ID, actor: env.BILLING_DLQ_ACTOR, reasonCode: env.BILLING_DLQ_REASON });
      process.stdout.write('Comando de reembolso registrado para avaliação.\n');
    } catch (error) {
      if (!settlementAttempted) await receiver.abandonMessage(message);
      throw error;
    }
  } finally { try { await receiver.close(); } finally { try { await bus.close(); } finally { await db.$disconnect(); } } }
}
main().catch(() => { process.stderr.write('Recuperação recusada ou indisponível; consulte a configuração e o comando selecionado.\n'); process.exitCode = 1; });
