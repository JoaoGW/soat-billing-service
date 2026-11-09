import { SmtpQuoteNotifier } from './quote-notifier';

describe('SmtpQuoteNotifier', () => {
  const transport = { sendMail: jest.fn() };
  const notifier = new SmtpQuoteNotifier(transport, 'oficina@example.test');
  beforeEach(() => { jest.resetAllMocks(); transport.sendMail.mockResolvedValue({ accepted: ['cliente@example.test'] }); });
  it('utiliza Message-ID estável e não inclui links de alteração por GET', async () => {
    await notifier.send({ notificationId: 'abc-123', recipient: 'cliente@example.test', quoteId: 'quote', osId: 'os' });
    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({ messageId: '<abc-123@soat.local>', to: 'cliente@example.test', subject: 'Orçamento disponível para consulta' }));
    const sent = transport.sendMail.mock.calls[0][0] as { text: string };
    expect(sent.text).not.toContain('http');
  });
  it('rejeita identificador impróprio sem enviar', async () => {
    await expect(notifier.send({ notificationId: 'id\nmalicioso', recipient: 'cliente@example.test', quoteId: 'quote', osId: 'os' })).rejects.toThrow();
    expect(transport.sendMail).not.toHaveBeenCalled();
  });
  it('não confirma envio se o SMTP recusar o destinatário', async () => {
    transport.sendMail.mockResolvedValue({ accepted: [] });
    await expect(notifier.send({ notificationId: 'abc-123', recipient: 'cliente@example.test', quoteId: 'quote', osId: 'os' })).rejects.toThrow('não confirmou');
  });
  it('rejeita múltiplos destinatários', async () => {
    await expect(notifier.send({ notificationId: 'abc-123', recipient: 'a@example.test,b@example.test', quoteId: 'quote', osId: 'os' })).rejects.toThrow('Destinatário inválido');
    expect(transport.sendMail).not.toHaveBeenCalled();
  });
});
