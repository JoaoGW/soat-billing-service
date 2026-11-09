import { SendMailOptions } from 'nodemailer';
import { QuoteNotifier } from '../../application/enviar-notificacao';

export interface MailTransport { sendMail(message: SendMailOptions): Promise<unknown> }

export class SmtpQuoteNotifier implements QuoteNotifier {
  constructor(private readonly transport: MailTransport, private readonly from: string) {}

  async send(message: { notificationId: string; recipient: string; quoteId: string; osId: string }): Promise<void> {
    if (!/^[a-z0-9-]+$/i.test(message.notificationId)) throw new Error('Identificador de notificação inválido');
    if (!/^[^\s<>(),;@]+@[^\s<>(),;@]+$/.test(message.recipient)) throw new Error('Destinatário inválido');
    const result = await this.transport.sendMail({
      from: this.from,
      to: message.recipient,
      messageId: `<${message.notificationId}@soat.local>`,
      subject: 'Orçamento disponível para consulta',
      text: `O orçamento ${message.quoteId} da ordem ${message.osId} está disponível para consulta. Entre em contato com a oficina para acessar o orçamento.`,
    });
    if (typeof result !== 'object' || result === null || !('accepted' in result) || !Array.isArray(result.accepted) ||
        !result.accepted.some((value: unknown) => typeof value === 'string' && value.toLowerCase() === message.recipient.toLowerCase())) {
      throw new Error('SMTP não confirmou destinatário');
    }
  }
}
