import { SmtpQuoteNotifier } from './quote-notifier';

describe('SmtpQuoteNotifier', () => {
  const quote = { quoteId: 'quote', osId: 'os', version: 2, totalInCents: 1500, currency: 'BRL', expiresAt: new Date('2030-01-02T00:00:00Z'), items: [{ description: 'Pastilha de freio', quantity: 3, unitPriceInCents: 500 }] };
  const transport = { sendMail: jest.fn() };
  const notifier = new SmtpQuoteNotifier(transport, 'oficina@example.test');
  beforeEach(() => { jest.resetAllMocks(); transport.sendMail.mockResolvedValue({ accepted: ['cliente@example.test'] }); });
  it('utiliza Message-ID estável e não inclui links de alteração por GET', async () => {
    await notifier.send({ notificationId: 'abc-123', recipient: 'cliente@example.test', ...quote });
    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({ messageId: '<abc-123@soat.local>', to: 'cliente@example.test', subject: 'Orçamento para aprovação - OS os' }));
    const sent = transport.sendMail.mock.calls[0][0] as { text: string };
    expect(sent.text).not.toContain('http');
    expect(sent.text).toContain('Pastilha de freio: 3 x R$');
    expect(sent.text).toMatch(/Total: R\$\s?15,00/);
    expect(sent.text).toContain('versão 2');
    expect(sent.text).toContain('/orcamentos/quote/aprovar');
  });
  it('rejeita identificador impróprio sem enviar', async () => {
    await expect(notifier.send({ notificationId: 'id\nmalicioso', recipient: 'cliente@example.test', ...quote })).rejects.toThrow();
    expect(transport.sendMail).not.toHaveBeenCalled();
  });
  it('não confirma envio se o SMTP recusar o destinatário', async () => {
    transport.sendMail.mockResolvedValue({ accepted: [] });
    await expect(notifier.send({ notificationId: 'abc-123', recipient: 'cliente@example.test', ...quote })).rejects.toThrow('não confirmou');
  });
  it('rejeita múltiplos destinatários', async () => {
    await expect(notifier.send({ notificationId: 'abc-123', recipient: 'a@example.test,b@example.test', ...quote })).rejects.toThrow('Destinatário inválido');
    expect(transport.sendMail).not.toHaveBeenCalled();
  });
});
