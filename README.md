# Billing Service — Fase 4

Esqueleto em desenvolvimento. Este repositório ainda não implementa o serviço
financeiro nem está pronto para receber tráfego ou efetuar deploy.

O schema próprio contém orçamento, decisão, cobrança, tentativas, pagamento,
reembolso, inbox e outbox. A migration inicial foi verificada em PostgreSQL
temporário. As funções de domínio testam valores inteiros e decisões por cliente
e versão. A operação interna de decisão grava CAS, decisão, idempotência e
outbox na mesma transação SQL. A geração interna grava orçamento, itens, inbox,
operação, evento e tarefa de notificação em uma transação. Essas operações ainda
não estão ligadas a uma API autenticada ou consumidor de mensageria.

Com Node 24: `npm ci`, `npm run lint`, `npm run build`, `npm run test:cov`.
Para gerar o cliente e aplicar migrations ao banco dedicado configurado em
`DATABASE_URL`, usar `npm run db:generate` e `npm run db:migrate:deploy`.
Não executar migrations sobre o banco legado.
`npm run test:integration` exige `DATABASE_URL` para um banco local cujo nome
termine em `_test`, com migrations aplicadas; não ignora ausência de ambiente.

Pendentes: APIs e autorização, validação dos contratos no transporte, worker de
notificações e publicação de outbox,
consumidores/Service Bus, Orders API e webhook Mercado Pago, reconciliação,
Sonar, deploy automatizado, instrumentação e testes distribuídos.
