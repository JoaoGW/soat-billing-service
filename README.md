# Billing Service — Fase 4

Esqueleto em desenvolvimento. Este repositório ainda não implementa o serviço
financeiro nem está pronto para receber tráfego ou efetuar deploy.

O schema próprio contém orçamento, decisão, cobrança, tentativas, pagamento,
reembolso, inbox e outbox. A migration inicial foi verificada em PostgreSQL
temporário. As funções de domínio testam valores inteiros e decisões por cliente
e versão. A operação interna de decisão grava CAS, decisão, idempotência e
outbox na mesma transação SQL. A geração interna grava orçamento, itens, inbox,
operação, evento e tarefa de notificação em uma transação. A geração é chamada
pelo consumidor opcional. `GET /orcamentos/:id` e os POSTs de aprovação e
recusa exigem JWT de cliente. Os POSTs também exigem `Idempotency-Key` e corpo
`{ "versao": 1 }`; o cliente é obtido do token e validado no orçamento.
O despachante da outbox reserva mensagens entre workers, retenta com o mesmo ID
e registra falhas após cinco tentativas. O adapter Service Bus e o worker usam
identidade de workload e permanecem desativados por padrão. O caminho local foi
testado com broker simulado. Falhas definitivas de prazo e orçamento existente
geram evento transacional antes do ACK; outros cenários de falha ainda precisam
ser definidos. Faltam o spike com Service Bus real e reprocessamento operacional
das falhas antes de habilitar o worker.
O worker SMTP também é desativado por padrão e exige TLS; ele usa ID de
mensagem estável, mas uma falha após aceitação pelo servidor pode provocar
reenvio. Não há garantia de deduplicação na caixa de entrada. Notificações de
orçamentos já decididos ou expirados são ignoradas.

Com Node 24: `npm ci`, `npm run lint`, `npm run build`, `npm run test:cov`.
Para gerar o cliente e aplicar migrations ao banco dedicado configurado em
`DATABASE_URL`, usar `npm run db:generate` e `npm run db:migrate:deploy`.
Não executar migrations sobre o banco legado.
`npm run test:integration` exige `DATABASE_URL` para um banco local cujo nome
termine em `_test`, com migrations aplicadas; não ignora ausência de ambiente.

A intenção de cobrança é gravada com chave idempotente antes do envio. O envio
reivindica a intenção, não repete operações em voo e sinaliza reconciliação em
caso de resposta incerta. O consumidor opcional grava inbox e emite evento de
cobrança criada na mesma transação da confirmação local. Prazo vencido produz
evento de falha antes do ACK. Outros resultados incertos permanecem para retry
e reconciliação; esgotadas as tentativas, seguem para a DLQ. Ainda falta uma
ferramenta operacional de reconciliação e tratamento das demais falhas.

O consumidor de cobrança exige `ENABLE_SERVICE_BUS_WORKER=true`,
`ENABLE_MERCADO_PAGO_COMMANDS=true` e `MERCADO_PAGO_ACCESS_TOKEN`; ambos os
workers e o comando financeiro permanecem desativados por padrão. Não habilitar
até validar os fluxos e credenciais em ambiente de teste.

O adapter de Orders API prepara criação de QR, consulta, cancelamento e
solicitação de reembolso com chave de idempotência e sem retry automático.
Falhas incertas em operações de escrita são classificadas para reconciliação.
O webhook usa HMAC e registra notificações antes de confirmar o recebimento.
Um processador opcional consulta a order e o pagamento canônicos, confere
referência, valor, moeda, estado, reembolsos e data de aprovação, e grava o
pagamento e seu evento atomicamente. Pagamento tardio é persistido para
reconciliação, sem emitir evento que libere trabalho. Os testes usaram
PostgreSQL local e HTTP simulado; a integração real ainda precisa ser validada.
O endpoint e processador exigem `ENABLE_MERCADO_PAGO_WEBHOOK=true`,
`ENABLE_MERCADO_PAGO_WEBHOOK_PROCESSOR=true`, `MERCADO_PAGO_WEBHOOK_SECRET` e
`MERCADO_PAGO_ACCESS_TOKEN`. Estão desativados por padrão e não devem ser
habilitados antes da validação completa em ambiente de teste.

Referências: [Orders QR](https://www.mercadopago.com.br/developers/pt/reference/in-person-payments/qr-code/orders/create-order/post),
[cancelamento](https://www.mercadopago.com.br/developers/pt/reference/in-person-payments/qr-code/orders/cancel-order/post),
[reembolso](https://www.mercadopago.com.br/developers/pt/reference/in-person-payments/qr-code/orders/refund-order/post)
e [webhooks QR](https://www.mercadopago.com.br/developers/pt/docs/qr-code/notifications).

O fluxo de reembolso registra intenção e chave idempotente antes da chamada,
exige evidência persistida de cancelamento anterior ao início do reparo e
confirma o resultado por consulta canônica antes de gravar o evento na outbox.
Resultados incertos permanecem em reconciliação, sem nova chamada automática.
Os serviços de reembolso ainda não estão conectados ao broker: falta ingestão
autenticada da evidência de cancelamento e orquestração da Saga. Os testes usam
PostgreSQL local e provedor simulado; não habilitar reembolso automático antes
de validar identidade dos produtores e o contrato real do Mercado Pago.

Pendentes: consultas de cobrança, cobertura das demais falhas definitivas,
reprocessamento operacional e teste real do SMTP e Service Bus, Orders API e webhook Mercado
Pago, reconciliação,
Sonar, deploy automatizado, instrumentação e testes distribuídos.
