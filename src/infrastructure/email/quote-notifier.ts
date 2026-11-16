import { SendMailOptions } from 'nodemailer';
import { QuoteMessage, QuoteNotifier } from '../../application/enviar-notificacao';

export interface MailTransport { sendMail(message: SendMailOptions): Promise<unknown> }

const money = (cents: number, currency: string) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(cents / 100);

/** Texto do orçamento enviado para aprovação: itens, total, validade e como decidir (sem links que alterem estado por GET). */
export function quoteText(message: QuoteMessage): string {
  const lines = message.items.map((item) => `- ${item.description}: ${item.quantity} x ${money(item.unitPriceInCents, message.currency)} = ${money(item.quantity * item.unitPriceInCents, message.currency)}`);
  return [
    `Olá! O orçamento da sua ordem de serviço ${message.osId} está pronto para aprovação.`,
    '',
    `Orçamento: ${message.quoteId} (versão ${message.version})`,
    ...lines,
    `Total: ${money(message.totalInCents, message.currency)}`,
    `Válido até: ${message.expiresAt.toISOString()}`,
    '',
    'Para aprovar ou recusar, acesse a área do cliente com o seu CPF ou peça à oficina.',
    `A decisão é registrada em POST /orcamentos/${message.quoteId}/aprovar ou /recusar, informando a versão ${message.version}.`,
    'Após a aprovação, você receberá o QR Code do Mercado Pago para pagamento.',
  ].join('\n');
}

export class SmtpQuoteNotifier implements QuoteNotifier {
  constructor(private readonly transport: MailTransport, private readonly from: string) {}

  async send(message: QuoteMessage): Promise<void> {
    if (!/^[a-z0-9-]+$/i.test(message.notificationId)) throw new Error('Identificador de notificação inválido');
    if (!/^[^\s<>(),;@]+@[^\s<>(),;@]+$/.test(message.recipient)) throw new Error('Destinatário inválido');
    const result = await this.transport.sendMail({
      from: this.from,
      to: message.recipient,
      messageId: `<${message.notificationId}@soat.local>`,
      subject: `Orçamento para aprovação - OS ${message.osId}`,
      text: quoteText(message),
    });
    if (typeof result !== 'object' || result === null || !('accepted' in result) || !Array.isArray(result.accepted) ||
        !result.accepted.some((value: unknown) => typeof value === 'string' && value.toLowerCase() === message.recipient.toLowerCase())) {
      throw new Error('SMTP não confirmou destinatário');
    }
  }
}
