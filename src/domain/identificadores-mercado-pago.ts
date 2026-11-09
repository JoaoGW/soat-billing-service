// A Orders API identifica recursos do modo de teste com o prefixo TST após o
// tipo (ex.: ORDTST01...); em produção o identificador não tem esse trecho.
export const MERCADO_PAGO_ORDER_ID = /^ORD(?:TST)?[a-z0-9]{26}$/i;
export const MERCADO_PAGO_REFUND_ID = /^REF(?:TST)?[a-z0-9]{26}$/i;
