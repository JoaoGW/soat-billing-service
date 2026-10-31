import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { calculateTotal } from '../domain/orcamento';

export interface GenerateQuoteCommand {
  messageId: string;
  operationId: string;
  osId: string;
  sagaId: string;
  filialId: string;
  correlationId: string;
  data: {
    clienteId: string;
    contato: string;
    diagnosisId: string;
    diagnosisVersion: number;
    expiresAt: string;
    items: { sourceId: string; itemType: 'PART' | 'SERVICE'; quantity: number; unitPriceInCents: number; description?: string }[];
  };
}

export class GenerateQuoteService {
  constructor(private readonly prisma: PrismaClient) {}

  async execute(command: GenerateQuoteCommand, now = new Date()): Promise<{ quoteId: string; version: number }> {
    const d = command.data;
    if (![command.messageId, command.operationId, command.osId, command.sagaId, command.filialId, command.correlationId, d?.clienteId, d?.contato, d?.diagnosisId].every((value) => typeof value === 'string' && value.trim().length > 0) ||
      !Number.isSafeInteger(d.diagnosisVersion) || d.diagnosisVersion < 1 || !Array.isArray(d.items) ||
      !Number.isFinite(new Date(d.expiresAt).getTime()) || !Number.isFinite(now.getTime()) ||
      !d.items.every((item) => typeof item.sourceId === 'string' && item.sourceId.length > 0 && ['PART', 'SERVICE'].includes(item.itemType) && Number.isSafeInteger(item.quantity) && item.quantity > 0 && item.quantity <= 2147483647 && Number.isSafeInteger(item.unitPriceInCents) && item.unitPriceInCents >= 0 && item.unitPriceInCents <= 2147483647 && (item.description === undefined || typeof item.description === 'string'))) throw new Error('Comando inválido');
    const total = calculateTotal(d.items);
    if (total > 2147483647) throw new Error('Total fora do limite do banco');
    const consumer = 'billing.generate-quote.v1';
    const normalized = { osId: command.osId, sagaId: command.sagaId, filialId: command.filialId, data: { clienteId: d.clienteId, contato: d.contato, diagnosisId: d.diagnosisId, diagnosisVersion: d.diagnosisVersion, expiresAt: d.expiresAt, items: d.items.map((item) => ({ sourceId: item.sourceId, itemType: item.itemType, quantity: item.quantity, unitPriceInCents: item.unitPriceInCents, description: item.description ?? '' })) } };
    const payloadHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const priorMessage = await tx.inbox.findUnique({ where: { consumer_messageId: { consumer, messageId: command.messageId } } });
          if (priorMessage && priorMessage.operationId !== command.operationId) throw new Error('Mensagem reutilizada em outra operação');
          const priorOperation = await tx.commandOperation.findUnique({ where: { consumer_operationId: { consumer, operationId: command.operationId } } });
          if (priorOperation) {
            if (priorOperation.payloadHash !== payloadHash) throw new Error('Operação reutilizada com outro conteúdo');
            if (!priorMessage) await tx.inbox.create({ data: { consumer, messageId: command.messageId, operationId: command.operationId, type: consumer, payload: { ...normalized }, status: 'APPLIED', appliedAt: now } });
            return priorOperation.result as { quoteId: string; version: number };
          }
          if (priorMessage) throw new Error('Mensagem sem operação correspondente');
          if (new Date(d.expiresAt) <= now) throw new Error('Comando expirado');
          const existing = await tx.quote.findFirst({ where: { osId: command.osId }, select: { id: true } });
          if (existing) throw new Error('Orçamento já existente para a OS');
          const quoteId = randomUUID();
          const result = { quoteId, version: 1 };
          await tx.quote.create({ data: { id: quoteId, osId: command.osId, sagaId: command.sagaId, filialId: command.filialId, clientId: d.clienteId, version: 1, totalInCents: total, currency: 'BRL', status: 'ISSUED', expiresAt: new Date(d.expiresAt), items: { create: d.items.map((item) => ({ id: randomUUID(), sourceId: item.sourceId, itemType: item.itemType, quantity: item.quantity, unitPriceInCents: item.unitPriceInCents, description: item.description || item.sourceId })) } } });
          const messageId = randomUUID();
          const type = 'billing.quote-issued.v1';
          await tx.outbox.create({ data: { messageId, type, payload: { messageId, type, schemaVersion: 1, occurredAt: now.toISOString(), producer: 'soat-billing-service', aggregateType: 'quote', aggregateId: quoteId, aggregateVersion: 1, osId: command.osId, sagaId: command.sagaId, filialId: command.filialId, correlationId: command.correlationId, causationId: command.messageId, operationId: command.operationId, data: { quoteId, quoteVersion: 1, clientId: d.clienteId, totalInCents: total, currency: 'BRL', expiresAt: d.expiresAt } } } });
          await tx.notification.create({ data: { id: randomUUID(), quoteId, recipient: d.contato } });
          await tx.inbox.create({ data: { consumer, messageId: command.messageId, operationId: command.operationId, type: consumer, payload: { ...normalized }, status: 'APPLIED', appliedAt: now } });
          await tx.commandOperation.create({ data: { consumer, operationId: command.operationId, payloadHash, result } });
          return result;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        const e = error as { code?: string; meta?: { code?: string } } | null;
        if (attempt < 4 && (e?.code === 'P2034' || e?.code === 'P2002' || (e?.code === 'P2010' && ['40001', '40P01'].includes(e.meta?.code ?? '')))) {
          await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
          continue;
        }
        throw error;
      }
    }
  }
}
