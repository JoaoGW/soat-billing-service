# Billing Service — Fase 4

Esqueleto em desenvolvimento. Este repositório ainda não implementa o serviço
financeiro nem está pronto para receber tráfego ou efetuar deploy.

O schema próprio contém orçamento, decisão, cobrança, tentativas, pagamento,
reembolso, inbox e outbox. A migration inicial foi verificada em PostgreSQL
temporário. As funções de domínio testam valores inteiros e decisões por cliente
e versão; a persistência transacional com CAS e outbox ainda precisa ser ligada.

Com Node 24: `npm ci`, `npm run lint`, `npm run build`, `npm run test:cov`.
Para gerar o cliente e aplicar migrations ao banco dedicado configurado em
`DATABASE_URL`, usar `npm run db:generate` e `npm run db:migrate:deploy`.
Não executar migrations sobre o banco legado.

Pendentes: APIs e autorização, persistência transacional, notificações,
consumidores/Service Bus, Orders API e webhook Mercado Pago, reconciliação,
Sonar, deploy automatizado, instrumentação e testes distribuídos.
