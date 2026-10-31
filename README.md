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

Pendentes: consultas de cobrança, cobertura das demais falhas definitivas,
reprocessamento operacional e teste real do SMTP e Service Bus, Orders API e webhook Mercado
Pago, reconciliação,
Sonar, deploy automatizado, instrumentação e testes distribuídos.
