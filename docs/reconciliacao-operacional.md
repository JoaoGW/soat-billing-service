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

## Publicação de evento esgotada

Depois de restaurar o broker, um operador com acesso autorizado ao banco de
Billing pode recuperar um evento `FAILED` com `npm run ops:recover-outbox`.
Primeiro confira o evento, o estado de OS e Execution, as chaves de assinatura
e a causa da falha. A publicação anterior pode ter chegado ao destinatário;
confirme a capacidade de deduplicação pelo `messageId` original. Não altere
payload nem IDs para forçar o processamento.

Execute a versão compilada correspondente aos contratos implantados, com
`ENABLE_BILLING_OUTBOX_RECOVERY=true`, `BILLING_RECOVERY_MESSAGE_ID`,
`BILLING_RECOVERY_ACTOR` e `BILLING_RECOVERY_REASON`. O motivo é um código em
letras maiúsculas, números ou `_`, como `BROKER_RESTORED`. A ferramenta exige
`DATABASE_URL` e a migration `20261106000000_billing_recovery_audit` aplicada.
O ator é informado pelo ambiente, não autenticado pela ferramenta: restrinja a
execução e a credencial de banco à identidade operacional apropriada e associe
o ator aos registros de acesso da plataforma.

O comando aceita somente eventos Billing conhecidos, ainda em `FAILED`, sem
claim e sem marca de publicação, cujo envelope e schema atual sejam válidos.
Ele registra ator, motivo, identificador, tipo e hash do payload na tabela
`BillingRecoveryAudit` e rearma a mesma mensagem na mesma transação. Um segundo
rearme concorrente ou posterior é recusado. O resultado não prova a entrega:
acompanhe a outbox, os consumidores e a deduplicação. O procedimento não altera
eventos `SENT`, comandos, cobranças, pagamentos ou reembolsos, nem resolve
automaticamente divergências de estados físicos ou financeiros.

## Comando de orçamento na DLQ

Após corrigir a causa, `npm run ops:recover-quote-dlq` pode tratar um comando
`billing.generate-quote.v1` autenticado. Configure
`ENABLE_BILLING_DLQ_RECOVERY=true`, `BILLING_DLQ_MESSAGE_ID`,
`BILLING_DLQ_ACTOR` e `BILLING_DLQ_REASON` (código em letras maiúsculas,
números ou `_`), além de `DATABASE_URL`, `OS_MESSAGE_PUBLIC_KEY`,
`SERVICE_BUS_NAMESPACE`, `SERVICE_BUS_COMMAND_QUEUE` e as variáveis de identidade
de workload do Azure. A identidade precisa receber da DLQ da fila. A ferramenta
examina apenas a primeira mensagem; se o ID não corresponder, ela a abandona e
interrompe. Não modifica mensagens não autenticadas ou incompatíveis.

Cada tentativa validada é registrada em `BillingRecoveryAudit` antes de usar o
handler normal de orçamento. O ACK acontece somente após verificar inbox e
operação duráveis. Caso a resposta do ACK seja perdida, confira a inbox e a
auditoria: uma nova entrega do mesmo comando passa pela deduplicação e pode
registrar outra tentativa, sem gerar outro orçamento. O ator é informado pelo
ambiente e deve ser correlacionado aos registros de acesso da plataforma.

Esta ferramenta recupera somente orçamento; para cobrança use o procedimento
específico abaixo.
Ela foi testada na DLQ de uma fila emulada, não no Service Bus real. Em um
ensaio, o emulador retornou erro de lock após o commit; não há evidência de
que esse erro explique a intermitência histórica do teste de reembolso.

## Evidência e comando de reembolso na DLQ

Antes de qualquer recuperação, confira a Saga, o pagamento, a reserva, o estado
físico e a evidência de cancelamento com OS e Execution. A recuperação registra
o documento usando o consumidor normal; se o worker de reembolso estiver ativo
e encontrar comando e evidência compatíveis, ele poderá iniciar o fluxo de
reembolso. Suspenda esse worker antes da operação caso seja necessária análise
adicional. Não altere payloads ou identificadores para forçar uma compensação.

Para uma evidência `execution.work-cancelled.v1` na DLQ da subscription, use
`npm run ops:recover-evidence-dlq` e `ENABLE_BILLING_EVIDENCE_DLQ_RECOVERY=true`,
com `EXECUTION_MESSAGE_PUBLIC_KEY`, `SERVICE_BUS_EVENT_TOPIC` e
`SERVICE_BUS_BILLING_EVIDENCE_SUBSCRIPTION`. Para um comando
`billing.refund-payment.v1` na DLQ da fila, use `npm run ops:recover-refund-dlq`
e `ENABLE_BILLING_REFUND_DLQ_RECOVERY=true`, com `OS_MESSAGE_PUBLIC_KEY` e
`SERVICE_BUS_COMMAND_QUEUE`. Ambos exigem as variáveis comuns de banco,
namespace, identidade de workload e `BILLING_DLQ_MESSAGE_ID`,
`BILLING_DLQ_ACTOR` e `BILLING_DLQ_REASON` descritas acima.

Cada ferramenta verifica assinatura, produtor, schema, assunto e ID, registra a
tentativa de auditoria e confirma a DLQ apenas após comprovar o registro exato
na inbox. Uma falha de ACK pode exigir nova tentativa e outra auditoria; a
inbox deduplica o conteúdo. Nenhuma delas chama o provedor diretamente. Os
ensaios usam DLQ de fila e banco locais; a DLQ da subscription, identidade e
permissões reais ainda precisam ser validadas no ambiente de aceite.

## Cobrança já comprovada na DLQ

`npm run ops:recover-charge-dlq` confirma apenas um comando de cobrança cujo
resultado já esteja registrado como `CREATED` ou `EXPIRED`. Configure
`ENABLE_BILLING_CHARGE_DLQ_RECOVERY=true`, `OS_MESSAGE_PUBLIC_KEY`,
`SERVICE_BUS_COMMAND_QUEUE` e as variáveis comuns de banco, namespace,
identidade, ID, ator e motivo descritas acima. A ferramenta recebe somente a
primeira mensagem e exige coincidência exata do ID, assinatura e contrato.

Ela confere fingerprint, inbox, tentativa, dados da cobrança e um único evento
correspondente na outbox. A verificação e a auditoria são transacionais; após
o commit, o comando é confirmado sem chamar o provedor. Se o evento estiver
`FAILED`, avalie seu rearme pelo procedimento próprio da outbox. Estados
`INTENT_RECORDED`, `IN_FLIGHT`, `RECONCILIACAO_NECESSARIA`, dados divergentes
ou evidência ausente permanecem na DLQ para análise: a ferramenta não presume
sucesso nem cria cobrança. A DLQ e as permissões reais ainda exigem validação.

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
O evento `billing.refund-blocked.v1` é gravado na outbox na mesma transação que
o incidente. O OS validará o evento assinado e a correspondência com o comando
antes de sinalizar a Saga; implante uma versão do OS que conheça esse contrato
antes de habilitar a publicação da nova versão de Billing. Confira a assinatura
e a entrega na subscription e na DLQ no ambiente real.

Em `PROVIDER_RESULT_UNKNOWN`, Billing não repete o pedido ao provedor. Quando a
consulta canônica comprovar o reembolso, o evento de confirmação permite ao OS
retomar a compensação somente com cancelamento autenticado e sem evidências ou
operações físicas conflitantes. A retomada é auditada; dados incompletos ou
conflitantes permanecem em reconciliação. `EVIDENCE_MISMATCH` não é resolvido
automaticamente por uma confirmação financeira.

O worker examina até 20 operações por ciclo, percorrendo os identificadores em
ordem e retomando no lote seguinte. Falha em uma operação, na outbox ou no
processamento de um comando não impede a tentativa das outras. Casos sem
comprovação continuam pendentes. O cursor fica em memória e reinicia com o
processo; não há garantia de prazo, especialmente em reinícios frequentes ou
filas em crescimento. Acompanhe a idade e o volume dos incidentes.
Os comandos de reembolso com evidência autenticada também são percorridos por
identificador, retomando após falha e retornando ao início ao esgotar a fila.
O cursor também é local ao processo; ele não substitui monitoramento ou garante
prazo em caso de reinícios repetidos.

Os reconciliadores existentes não cobrem automaticamente toda a matriz de
incidentes; casos sem comprovação continuam pendentes para análise. Valide
primeiro no ambiente de teste do Mercado Pago e acompanhe outbox, inbox e DLQ.

### Cancelamento de cobrança em desenvolvimento

O processamento de `billing.cancel-charge.v1` está protegido por
`ENABLE_MERCADO_PAGO_CANCEL_COMMANDS` e permanece desativado por padrão. Não
habilite em um ambiente de uso: a emissão do comando e o tratamento do evento
`billing.charge-canceled.v1` pela Saga do OS ainda precisam ser integrados e
validados ponta a ponta. A implementação de Billing exige a evidência autenticada
`execution.work-cancelled.v1`, confere cobrança e reserva, registra a intenção
antes da chamada, consulta a order e tenta o cancelamento uma única vez. Para
retomadas, apenas consulta a situação canônica; timeout, dados divergentes ou
pagamento concorrente permanecem em reconciliação, sem liberar a reserva.
O polling é de 60 segundos e processa uma operação elegível por ciclo.
A validação real de formatos e estados de resposta continua pendente de contas
Mercado Pago e ambiente apropriado.
