# Contratos de mensagens v1

Conjunto completo das mensagens que o Billing produz ou consome na Saga
orquestrada pelo OS. Todo arquivo `*.v1.schema.json` estende
[`envelope.schema.json`](envelope.schema.json) (IDs de mensagem, correlação,
causa e operação, contexto `osId`/`sagaId`/`filialId`, versão local do agregado
produtor e `traceparent`/`tracestate` W3C opcionais) e tem um exemplo em
[`examples/`](examples). `npm run test:contracts` valida cada exemplo e recusa
produtor incorreto e `data` incompleto.

Toda mensagem é assinada com Ed25519 pelo produtor (`applicationProperties.signature`)
e o `subject` do Service Bus é igual ao `type` (divergência é recusada). Mensagem sem assinatura válida
ou fora do schema vai para a DLQ; nada é processado antes de ser gravado na
inbox.

## Comandos recebidos pelo Billing

Fila `billing.commands`, produzidos pelo `soat-os-service`.

| Tipo | Produtor | Consumidor | Resposta |
| --- | --- | --- | --- |
| `billing.generate-quote.v1` | soat-os-service | soat-billing-service | `quote-issued` ou `quote-failed` |
| `billing.create-charge.v1` | soat-os-service | soat-billing-service | `charge-created`, `charge-failed` e, após o webhook, `payment-confirmed` |
| `billing.cancel-charge.v1` | soat-os-service | soat-billing-service | `charge-canceled` ou `charge-cancel-blocked` |
| `billing.refund-payment.v1` | soat-os-service | soat-billing-service | `payment-refunded` ou `refund-blocked` |

## Eventos publicados pelo Billing

Tópico `soat.domain.events`, publicados pela outbox do Billing e consumidos pelo
OS (subscription `os.saga-events`).

| Tipo | Produtor | Consumidor | Significado |
| --- | --- | --- | --- |
| `billing.quote-issued.v1` | soat-billing-service | soat-os-service | Orçamento versionado emitido |
| `billing.quote-failed.v1` | soat-billing-service | soat-os-service | Orçamento recusado por regra de negócio |
| `billing.quote-approved.v1` | soat-billing-service | soat-os-service | Cliente aprovou a versão do orçamento |
| `billing.quote-rejected.v1` | soat-billing-service | soat-os-service | Cliente recusou a versão do orçamento |
| `billing.charge-created.v1` | soat-billing-service | soat-os-service | Order QR criada no Mercado Pago |
| `billing.charge-failed.v1` | soat-billing-service | soat-os-service | Cobrança não pôde ser criada |
| `billing.payment-confirmed.v1` | soat-billing-service | soat-os-service | Pagamento confirmado por consulta canônica |
| `billing.charge-canceled.v1` | soat-billing-service | soat-os-service | Cobrança sem pagamento cancelada |
| `billing.charge-cancel-blocked.v1` | soat-billing-service | soat-os-service | Cancelamento bloqueado; exige reconciliação |
| `billing.payment-refunded.v1` | soat-billing-service | soat-os-service | Estorno confirmado por consulta canônica |
| `billing.refund-blocked.v1` | soat-billing-service | soat-os-service | Estorno bloqueado (evidência divergente ou resultado incerto) |

## Evidência de compensação recebida do Execution

Tópico `soat.domain.events`, subscription `billing.evidence`. Os dois tipos são
verificados com a chave pública do Execution, validados pelo próprio schema e
gravados na mesma inbox `billing.compensation-evidence`. Gravar a evidência
nunca dispara estorno sozinho: só libera um comando do OS que a referencie.

| Tipo | Produtor | Consumidor | Uso no Billing |
| --- | --- | --- | --- |
| `execution.work-cancelled.v1` | soat-execution-service | soat-os-service, soat-billing-service | Com `outcome` `CANCELLED`, autoriza estorno e cancelamento de cobrança |
| `execution.work-failed.v1` | soat-execution-service | soat-os-service, soat-billing-service | Autoriza somente estorno, quando `operationId`/`messageId` são `cancelOperationId`/`cancelEventId` do comando e `osId`/`sagaId`/`filialId` coincidem |

O cancelamento de cobrança (`billing.cancel-charge.v1`) continua exigindo
`execution.work-cancelled.v1` com `CANCELLED`: a falha do reparo só ocorre
depois do pagamento. Evidência divergente gera `refund-blocked` ou
`charge-cancel-blocked` sem chamar o provedor.

## Comandos do Execution mantidos como referência

| Tipo | Produtor | Consumidor |
| --- | --- | --- |
| `execution.request-diagnosis.v1` | soat-os-service | soat-execution-service |
| `execution.reserve-parts.v1` | soat-os-service | soat-execution-service |

O Billing não consome esses comandos; os schemas ficam aqui para manter o
envelope comum alinhado entre os repositórios.

## Regras de evolução

Não enviar CPF, secrets ou connection strings. Alterações aditivas devem
preservar v1; mudanças incompatíveis exigem nova versão e convivência. Os
schemas compartilhados (`execution.*`) são copiados sem alteração dos
repositórios produtores.
