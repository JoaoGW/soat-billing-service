# Reconciliação operacional de pagamentos

Use credenciais de leitura próprias de Billing e registre identificadores da
OS, Saga, operação, estado e horários. Não copie CPF, QR, tokens, payloads ou
dados do cartão para chamados. Consulte OS e Execution por suas interfaces
autorizadas; Billing não acessa seus bancos.

| Situação | Verificação e ação segura |
| --- | --- |
| Criação em voo ou resposta incerta | Conferir intenção, chave da operação e notificação autenticada. Com ID e dados correspondentes, a reconciliação de cobrança consulta a order canônica; sem prova, manter pendência e não criar outra cobrança. |
| Reembolso em voo ou incerto | Consultar order, transação, referência, valor, moeda e reembolso integral. O reconciliador só confirma correspondência única; não repete o pedido. Informação ausente ou divergente permanece em reconciliação. |
| Comando de reembolso pendente | Conferir inbox de `billing.refund-staging` e evidência assinada de `execution.work-cancelled.v1`; sem confirmação de não início, não reembolsar. Erro de banco ou evidência divergente não autoriza chamar o provedor. |
| Evidência divergente | `billing.refund-staging` fica em `RECONCILIACAO_NECESSARIA`, mesmo sem registro em `Refund`. Investigar os IDs e o estado físico com OS e Execution; não reenviar nem alterar a evidência para forçar estorno. A resolução operacional exige comprovação e procedimento específico. |
| Reparo iniciado ou situação física incerta | Preservar reserva e estado financeiro; abrir incidente e consultar a equipe operacional. Não liberar estoque, nem iniciar estorno por timeout. |
| Mensagem na DLQ | Conferir produtor, assinatura, schema, IDs e estado atual. Corrigir a causa e reenviar apenas pelo procedimento específico do consumidor, preservando IDs; não editar payloads. |

Para localizar comandos em reconciliação, inclusive os que não criaram uma
intenção financeira, uma identidade autorizada de leitura pode consultar:

```sql
SELECT i."messageId", i."operationId", i."appliedAt",
       i."payload"->>'osId' AS "osId",
       i."payload"->>'sagaId' AS "sagaId",
       i."payload"->'data'->>'cancelEventId' AS "cancelEventId",
       e."payload"->'data'->>'outcome' AS "cancelOutcome",
       r."status" AS "refundStatus"
FROM "Inbox" i
LEFT JOIN "Inbox" e ON e."consumer" = 'billing.compensation-evidence'
  AND e."messageId" = i."payload"->'data'->>'cancelEventId'
LEFT JOIN "Refund" r ON r."operationId" = i."operationId"
WHERE i."consumer" = 'billing.refund-staging'
  AND i."status" = 'RECONCILIACAO_NECESSARIA';
```

Se `refundStatus` estiver vazio, não há intenção de reembolso para o comando.
A consulta não resolve o incidente nem autoriza repetir uma solicitação.

Os reconciliadores existentes não cobrem automaticamente toda a matriz de
incidentes; casos sem comprovação continuam pendentes para análise. Valide
primeiro no ambiente de teste do Mercado Pago e acompanhe outbox, inbox e DLQ.
