/**
 * Emuladores só são aceitos com ALLOW_LOCAL_EMULATORS=true. Em produção a
 * conexão continua exclusiva por identidade de workload.
 */
export function localServiceBusConnection(): string | undefined {
  if (process.env.ALLOW_LOCAL_EMULATORS !== 'true') return undefined;
  const connection = process.env.SERVICE_BUS_CONNECTION_STRING;
  return connection && /(^|;)\s*UseDevelopmentEmulator=true\s*(;|$)/i.test(connection) ? connection : undefined;
}

/** Permite o provedor simulado do ambiente local; sem a trava usa sempre a API oficial. */
export function mercadoPagoBaseUrl(): string {
  const local = process.env.ALLOW_LOCAL_EMULATORS === 'true' ? process.env.MERCADO_PAGO_API_BASE_URL : undefined;
  if (!local) return 'https://api.mercadopago.com';
  const url = new URL(local);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('MERCADO_PAGO_API_BASE_URL inválida');
  return url.origin;
}
