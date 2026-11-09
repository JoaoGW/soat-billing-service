import { localServiceBusConnection, mercadoPagoBaseUrl } from './local-emulators';

describe('emuladores locais', () => {
  const originalEnv = process.env;
  const emulator = 'Endpoint=sb://servicebus;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;';
  beforeEach(() => { process.env = { ...originalEnv }; delete process.env.ALLOW_LOCAL_EMULATORS; delete process.env.SERVICE_BUS_CONNECTION_STRING; delete process.env.MERCADO_PAGO_API_BASE_URL; });
  afterEach(() => { process.env = originalEnv; });

  it('ignora connection string sem a trava explícita', () => {
    process.env.SERVICE_BUS_CONNECTION_STRING = emulator;
    expect(localServiceBusConnection()).toBeUndefined();
  });

  it('aceita somente connection string do emulador quando habilitado', () => {
    process.env.ALLOW_LOCAL_EMULATORS = 'true';
    process.env.SERVICE_BUS_CONNECTION_STRING = emulator;
    expect(localServiceBusConnection()).toBe(emulator);
    process.env.SERVICE_BUS_CONNECTION_STRING = 'Endpoint=sb://real.servicebus.windows.net/;SharedAccessKeyName=x;SharedAccessKey=y';
    expect(localServiceBusConnection()).toBeUndefined();
  });

  it('usa a API oficial do Mercado Pago por padrão', () => {
    process.env.MERCADO_PAGO_API_BASE_URL = 'http://mercado-pago-simulado:8080';
    expect(mercadoPagoBaseUrl()).toBe('https://api.mercadopago.com');
  });

  it('aceita o provedor simulado somente com a trava e URL válida', () => {
    process.env.ALLOW_LOCAL_EMULATORS = 'true';
    expect(mercadoPagoBaseUrl()).toBe('https://api.mercadopago.com');
    process.env.MERCADO_PAGO_API_BASE_URL = 'http://mercado-pago-simulado:8080/ignorado';
    expect(mercadoPagoBaseUrl()).toBe('http://mercado-pago-simulado:8080');
    process.env.MERCADO_PAGO_API_BASE_URL = 'ftp://simulado';
    expect(() => mercadoPagoBaseUrl()).toThrow('MERCADO_PAGO_API_BASE_URL inválida');
    process.env.MERCADO_PAGO_API_BASE_URL = 'http://user:pass@simulado';
    expect(() => mercadoPagoBaseUrl()).toThrow('MERCADO_PAGO_API_BASE_URL inválida');
  });
});
