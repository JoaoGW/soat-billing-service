# soat-billing-service

**Billing Service** da Fase 4 do Sistema Integrado de Oficina. É a autoridade
de orçamento versionado, aprovação do cliente, cobrança Mercado Pago,
pagamento, reembolso e notificações. Participa da Saga orquestrada pelo
[OS Service](https://github.com/JoaoGW/soat-api).

## Stack

- Node.js 24, TypeScript e NestJS;
- PostgreSQL exclusivo do serviço com Prisma;
- Azure Service Bus (comandos, eventos, inbox e outbox) com assinatura Ed25519;
- Mercado Pago Orders API (QR), webhook HMAC e consulta canônica;
- OpenTelemetry/New Relic, Jest, SonarJS, Docker, Kustomize e kind.

## Arquitetura

```mermaid
flowchart LR
  Cliente[Cliente] -->|JWT de cliente| API[Billing HTTP]
  OS[OS: orquestrador] -->|billing.commands| Bus[Service Bus]
  Bus --> Worker[Billing workers]
  API --> SQL[(PostgreSQL Billing)]
  Worker --> SQL
  Worker -->|Orders API| MP[Mercado Pago]
  MP -->|webhook HMAC| API
  Worker -->|eventos assinados| Topic[(topic soat.domain.events)]
  Topic --> OS
```

O schema próprio contém orçamento, itens, decisão, cobrança, tentativas,
pagamento, reembolso, inbox, outbox, notificações e auditoria de recuperação.
Nenhum outro serviço lê essas tabelas: o OS conhece o resultado financeiro
apenas pelos eventos. Valores são inteiros em centavos e o orçamento é
versionado; a decisão do cliente é vinculada ao cliente e à versão.

## Saga orquestrada

O OS coordena uma **Saga orquestrada**. A orquestração concentra prazos,
decisões e a ordem das compensações em um único dono do ciclo de vida da OS,
facilitando auditoria e retomada sem compartilhar o banco financeiro; na
coreografia, a regra de pagamento antes do reparo e a ordem dos estornos
ficariam espalhadas pelos participantes. Billing recebe comandos e responde com
eventos:

| Comando recebido | Eventos emitidos |
| --- | --- |
| `billing.generate-quote.v1` | `quote-issued`, `quote-failed` |
| decisão HTTP do cliente | `quote-approved`, `quote-rejected` |
| `billing.create-charge.v1` | `charge-created`, `charge-failed`, `payment-confirmed` |
| `billing.cancel-charge.v1` | `charge-canceled`, `charge-cancel-blocked` |
| `billing.refund-payment.v1` | `payment-refunded`, `refund-blocked` |

Na compensação, Billing exige evidência autenticada do Execution antes de
reembolsar. Ela chega pela subscription `billing.evidence`, é verificada com a
chave Ed25519 do Execution e o schema do tipo, e fica na inbox
`billing.compensation-evidence`. Dois fatos são aceitos para o estorno:

- `execution.work-cancelled.v1` com `outcome` `CANCELLED`: o reparo não começou;
- `execution.work-failed.v1`: o reparo começou e o mecânico o declarou inviável.
  As peças já foram consumidas, então a compensação é estornar o pagamento e
  cancelar a OS. O comando `billing.refund-payment.v1` só é aplicado se o
  evento vier de `soat-execution-service`, com `operationId` e `messageId`
  iguais a `cancelOperationId` e `cancelEventId` e os mesmos `osId`, `sagaId` e
  `filialId`.

Evidência divergente não chama o provedor: o comando fica em reconciliação e
Billing publica `refund-blocked` (`EVIDENCE_MISMATCH`). A cobrança sem pagamento
é cancelada somente com `work-cancelled` `CANCELLED` (a falha do reparo só
ocorre depois do pagamento), com intenção durável, uma única tentativa e
consulta canônica.
Transações locais são atômicas; resultados financeiros incertos (timeout,
resposta perdida, dados divergentes) ficam em reconciliação e nunca repetem a
mutação no provedor. Os schemas, com produtor e consumidor de cada um, estão em
[`docs/contracts/messages`](docs/contracts/messages).

```mermaid
sequenceDiagram
  autonumber
  participant OS as OS (orquestrador)
  participant B as Billing
  participant C as Cliente
  participant MP as Mercado Pago
  participant EX as Execution
  OS->>B: billing.generate-quote.v1
  B-->>OS: billing.quote-issued.v1 (ou quote-failed)
  C->>B: POST /orcamentos/:id/aprovar (JWT e Idempotency-Key)
  B-->>OS: billing.quote-approved.v1 (ou quote-rejected)
  OS->>B: billing.create-charge.v1
  B->>MP: cria order QR com chave de idempotência
  B-->>OS: billing.charge-created.v1 (ou charge-failed)
  C->>MP: paga o QR
  MP->>B: webhook assinado (HMAC)
  B->>MP: consulta canônica da order
  B-->>OS: billing.payment-confirmed.v1
  alt Cancelamento antes do pagamento
    EX-->>B: execution.work-cancelled.v1 CANCELLED (billing.evidence)
    OS->>B: billing.cancel-charge.v1
    B->>MP: cancela a order uma única vez
    B-->>OS: billing.charge-canceled.v1 (ou charge-cancel-blocked)
  else Pago e reparo não iniciado ou reparo falhou
    EX-->>B: work-cancelled CANCELLED ou execution.work-failed.v1 (billing.evidence)
    OS->>B: billing.refund-payment.v1 (cancelOperationId e cancelEventId)
    B->>MP: solicita reembolso uma única vez
    B-->>OS: billing.payment-refunded.v1 (ou refund-blocked)
  end
```

Todas as setas de e para o OS passam pelo Service Bus (fila `billing.commands`
e tópico `soat.domain.events`); os eventos do Billing saem pela outbox na mesma
transação do estado.

## API REST

A referência (Swagger/OpenAPI 3) está em [`docs/openapi.yaml`](docs/openapi.yaml) e a collection Postman do serviço em [`docs/postman/billing-service.postman_collection.json`](docs/postman/billing-service.postman_collection.json); a jornada completa pelos três serviços está na collection `docs/postman/fase4-microsservicos.postman_collection.json` do soat-api. O arquivo OpenAPI pode ser aberto no Swagger Editor ou importado no Postman.

| Rota | Proteção |
| --- | --- |
| `GET /health` | pública |
| `GET /orcamentos/:id` | JWT de cliente, dono do orçamento |
| `POST /orcamentos/:id/aprovar` e `/recusar` | JWT de cliente, `Idempotency-Key` e corpo `{ "versao": 1 }` |
| `GET /cobrancas/:id` e `GET /cobrancas/por-os/:osId` | JWT de cliente, dono do orçamento |
| `POST /webhooks/mercado-pago` | assinatura HMAC do Mercado Pago |

O QR é retornado apenas enquanto a cobrança está criada e não expirou. As
respostas não expõem chaves de idempotência nem identificadores internos do
provedor.

## Mercado Pago

O adapter da Orders API cria a order QR, consulta, cancela e solicita reembolso
com chave de idempotência e sem retry automático; falhas incertas em escrita são
classificadas para reconciliação. A intenção de cobrança é gravada antes do
envio, o envio reivindica a intenção e não repete operações em voo. O webhook
valida HMAC e registra a notificação antes de confirmar o recebimento; o
processador consulta order e pagamento canônicos, confere referência, valor,
moeda, estado e reembolsos, e grava pagamento e evento atomicamente. Pagamento
tardio é persistido para reconciliação sem liberar trabalho.

Para usar credenciais de **teste** do Mercado Pago, configure no secret do
ambiente:

| Variável | Uso |
| --- | --- |
| `MERCADO_PAGO_ACCESS_TOKEN` | Access token da aplicação de teste |
| `MERCADO_PAGO_WEBHOOK_SECRET` | Assinatura secreta do webhook |
| `ENABLE_MERCADO_PAGO_COMMANDS` | Criação de cobrança pelo worker |
| `ENABLE_MERCADO_PAGO_WEBHOOK` e `ENABLE_MERCADO_PAGO_WEBHOOK_PROCESSOR` | Recebimento e processamento do webhook |
| `ENABLE_MERCADO_PAGO_CHARGE_RECONCILIATION` | Recuperação de cobrança incerta por notificação autenticada |
| `ENABLE_MERCADO_PAGO_REFUND_COMMANDS` e `ENABLE_MERCADO_PAGO_REFUND_RECONCILIATION` | Reembolso e sua reconciliação a cada 60 segundos |
| `ENABLE_MERCADO_PAGO_CANCEL_COMMANDS` | Cancelamento de cobrança sem pagamento |

O OS precisa de `MERCADO_PAGO_EXTERNAL_POS_ID` da loja/caixa de teste e o
webhook deve apontar para a URL HTTPS pública do Billing. Todas as travas ficam
desativadas por padrão; habilite-as somente com contas de teste, sem valores
reais. Referências: [Orders QR](https://www.mercadopago.com.br/developers/pt/reference/in-person-payments/qr-code/orders/create-order/post),
[cancelamento](https://www.mercadopago.com.br/developers/pt/reference/in-person-payments/qr-code/orders/cancel-order/post),
[reembolso](https://www.mercadopago.com.br/developers/pt/reference/in-person-payments/qr-code/orders/refund-order/post)
e [webhooks QR](https://www.mercadopago.com.br/developers/pt/docs/qr-code/notifications).

## Configuração

Copie `.env.example`. O worker Service Bus exige `ENABLE_SERVICE_BUS_WORKER=true`,
`SERVICE_BUS_NAMESPACE`, `SERVICE_BUS_COMMAND_QUEUE`, `SERVICE_BUS_EVENT_TOPIC`,
identidade de workload, `OS_MESSAGE_PUBLIC_KEY` e a chave privada exclusiva
`BILLING_MESSAGE_PRIVATE_KEY`; comandos sem assinatura válida seguem à DLQ. A
subscription de evidência (`ENABLE_BILLING_COMPENSATION_EVIDENCE=true`,
`SERVICE_BUS_BILLING_EVIDENCE_SUBSCRIPTION` e `EXECUTION_MESSAGE_PUBLIC_KEY`)
aceita `execution.work-cancelled.v1` e `execution.work-failed.v1`, confirma
outros eventos do tópico sem processá-los e registra a evidência com o trace W3C
do produtor autenticado; registrar a evidência não dispara reembolso. O worker
SMTP (`ENABLE_NOTIFICATION_WORKER=true`) exige TLS e usa ID de mensagem estável.
Todas as variáveis lidas pelo código estão em `.env.example`, com padrão seguro.

Em Kubernetes os segredos não vêm de Key Vault: o Deployment recebe todas as
variáveis do Secret `soat-billing-runtime` via `envFrom`, e o job de migration
usa o Secret separado `soat-billing-migration` (só `DATABASE_URL`). No kind o CI
cria esses Secrets com valores aleatórios a cada execução; no AKS eles devem
existir previamente no namespace `hml` e o deploy falha se faltarem. O acesso
ao Service Bus usa identidade de workload (ServiceAccount anotada), sem
connection string. Não compartilhe chaves privadas entre serviços.

## Ambiente local com emuladores

Com `ALLOW_LOCAL_EMULATORS=true`, o worker aceita `SERVICE_BUS_CONNECTION_STRING`
do Service Bus Emulator (somente com `UseDevelopmentEmulator=true`) e o adapter
do Mercado Pago aceita `MERCADO_PAGO_API_BASE_URL` para o provedor simulado. Sem
a trava, a conexão continua exclusiva por identidade de workload e a API oficial
do Mercado Pago. O ambiente completo dos três serviços em kind está em
[soat-api/docs/ambiente-kind.md](https://github.com/JoaoGW/soat-api/blob/development/docs/ambiente-kind.md).

## Execução e testes

Com Node 24:

```bash
npm ci
npm run db:generate
npm run lint
npm run quality:sonarjs
npm run build
npm run test:cov
npm run test:coverage-infrastructure
npm run test:contracts
```

`npm run test:integration` exige `DATABASE_URL` para um banco local descartável
cujo nome termine em `_test`, com `npm run db:migrate:deploy` aplicado; a suíte
não ignora ausência de ambiente. Os testes `test:broker-*` usam o emulador
Service Bus descrito no OS. O fluxo completo com os três serviços é o BDD
distribuído do [OS](https://github.com/JoaoGW/soat-api#testes-cobertura-e-qualidade).

### Evidência de cobertura

O gate mínimo é 80% em cada métrica (`coverageThreshold` em `jest.config.cjs`).
Última medição local, com `npm run test:cov` e
`npm run test:coverage-infrastructure` (47 suítes, 234 testes unitários):

| Escopo | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- |
| Serviço | 89.35% | 84.53% | 90.90% | 94.48% |
| Infraestrutura | 93.61% | 91.21% | 90.69% | 96.63% |

A suíte de integração no PostgreSQL tem 17 suítes e 55 testes; o gate do
cancelamento de cobrança mede `cancelar-cobranca.ts` em 89.21% statements,
82.08% branches, 100% functions e 100% lines.

Os números de cada commit ficam no próprio CI, sem depender desta tabela:

- job **quality**, passo **Publicar resumo de cobertura**
  (`scripts/quality/coverage-summary.cjs`): tabela no resumo do job e anotações
  com os totais do SHA;
- artefato **`billing-coverage-<sha>`**: relatório completo (lcov, HTML e
  `coverage-summary.json`) do serviço e da infraestrutura;
- artefato `billing-cancel-charge-integration-<sha>` do job **integration**;
- [SonarCloud](https://sonarcloud.io/dashboard?id=JoaoGW_soat-billing-service):
  cobertura recebida de `coverage/lcov.info` e Quality Gate.

A qualidade é verificada no **SonarQube Cloud**
([painel do projeto](https://sonarcloud.io/dashboard?id=JoaoGW_soat-billing-service)): o CI
envia o código e a cobertura (`coverage/lcov.info`) e aguarda o Quality Gate *Sonar way*
(confiabilidade, segurança, manutenibilidade, duplicação ≤ 3% e cobertura ≥ 80%
no código novo); reprovação bloqueia o pipeline e o merge. Antes disso,
`npm run quality:sonarjs` aplica localmente regras selecionadas do SonarJS com
`--max-warnings=0`.

[![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=JoaoGW_soat-billing-service&metric=alert_status)](https://sonarcloud.io/project/overview?id=JoaoGW_soat-billing-service)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=JoaoGW_soat-billing-service&metric=coverage)](https://sonarcloud.io/project/overview?id=JoaoGW_soat-billing-service)

## CI/CD e deploy

O [CI](https://github.com/JoaoGW/soat-billing-service/actions/workflows/ci.yml)
roda em todo pull request e em push para `main` e `development`:

1. **quality**: lint, SonarJS, build, observabilidade local, cobertura do
   serviço e da infraestrutura (80% por métrica), contratos e manifests;
2. **integration**: migrations e testes de integração no PostgreSQL, gate de
   cobertura do cancelamento de cobrança e verificação das imagens de runtime e
   migração;
3. **Deploy Kubernetes (kind)**: cria um cluster kind efêmero, carrega as
   imagens do SHA, sobe o PostgreSQL próprio, executa o job de migration e
   aplica o overlay [`deploy/kustomize/overlays/kind`](deploy/kustomize/overlays/kind);
   valida rollout, imagem, `/health`, rota sem token (401) e consulta
   autenticada ao banco (404 para orçamento inexistente);
4. **publish** e **deploy_hml**: em push para `development`, publicam no GHCR e
   aplicam no AKS o mesmo SHA, somente com `HML_DEPLOY_ENABLED=true`.

A `main` exige pull request e os checks. O deploy AKS usa OIDC
(`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`), nomes do AKS,
`BILLING_WORKLOAD_CLIENT_ID` e os secrets `soat-ghcr-pull`,
`soat-billing-runtime` e `soat-billing-migration`, com a ServiceAccount
`soat-billing-migrator`; runtime e migrations usam credenciais distintas e a
migration do mesmo SHA roda antes do rollout. Enquanto a assinatura Azure
estiver desativada, o ambiente kind é o deploy automatizado verificável.

## Ambiente Kubernetes

- **Deploy automatizado (kind)**: o job **Deploy Kubernetes (kind)** do
  [CI](https://github.com/JoaoGW/soat-billing-service/actions/workflows/ci.yml)
  roda em todo pull request e push. Ele cria um cluster kind efêmero no runner,
  carrega as imagens do SHA, cria os Secrets, sobe o PostgreSQL próprio, roda o
  job de migration antes do rollout e valida imagem, `/health`, 401 sem token e
  404 autenticado. O resultado aparece no resumo do job.
- **Fluxo distribuído completo**: o workflow
  [**Fluxo completo em Kubernetes**](https://github.com/JoaoGW/soat-api/actions/workflows/fluxo-completo-kind.yml)
  do `soat-api` sobe OS, Billing e Execution no kind, com broker e banco
  emulados e provedor simulado, e exercita a jornada e as compensações. Ele
  roda quando o repositório aceitou os termos dos emuladores
  (`SOAT_ACCEPT_EULA=Y`).
- **AKS (`deploy_hml`)**: continua atrás de `HML_DEPLOY_ENABLED` porque a
  assinatura Azure está desativada. Os manifests e o pipeline estão prontos;
  sem a variável, `publish` e `deploy_hml` são pulados.


No kind, a telemetria do serviço vai ao OpenTelemetry Collector do cluster
(`ALLOW_LOCAL_EMULATORS=true` permite HTTP e dispensa a chave), que alimenta
Jaeger, Prometheus e Grafana sem custo e encaminha ao New Relic quando a chave
existe. O workflow do soat-api confirma no Jaeger um único trace atravessando
OS, Billing e Execution.

O orçamento é enviado ao cliente por e-mail para aprovação (itens, total, validade e como aprovar) pelo worker de notificações (`ENABLE_NOTIFICATION_WORKER=true`). No kind o envio vai ao Mailpit do cluster (http://localhost:8025 com `scripts/kind/ambiente.sh portas`), sem TLS nem credenciais (`ALLOW_LOCAL_EMULATORS=true`); fora dele o SMTP exige TLS e autenticação.

## Observabilidade

Traces e métricas OpenTelemetry são exportados ao New Relic, como na Fase 3:
`OBSERVABILITY_ENABLED=true`, `NEW_RELIC_LICENSE_KEY` no secret,
`OTEL_SERVICE_VERSION` com o SHA e `OTEL_EXPORTER_OTLP_ENDPOINT` opcional. A
instrumentação inicia antes do Nest, propaga o contexto W3C nas mensagens e é
encerrada no shutdown. `npm run build && npm run test:observability-local`
verifica a exportação para um coletor local.

## Operação

O [procedimento de reconciliação](docs/reconciliacao-operacional.md) descreve
ações seguras para resultados incertos e as recuperações auditadas
(`ops:recover-outbox` e `ops:recover-*-dlq`), que só confirmam a mensagem após
comprovar o estado persistido e ficam travadas sem habilitação explícita.

## Dependências

O `package-lock.json` fixa Multer 2.5.0 por `overrides` para corrigir o aviso
GHSA-q7qp-rjg7-q26m na versão transitiva fixada pelo Nest; um teste exercita o
interceptor HTTP com filtro assíncrono. Remova o override quando uma versão
compatível do Nest incorporar a correção. A imagem de runtime remove o CLI
`prisma` e a cadeia `@prisma/config`/`deepmerge-ts`; a imagem separada de
migração conserva o CLI.

Os overrides de `@prisma/config > deepmerge-ts` (8.0.2) e
`gcp-metadata > gaxios` (8.3.2) corrigem os alertas altos da cadeia do CLI de
migração e moderados do detector de metadados; com eles, `npm audit --omit=dev`
não aponta vulnerabilidades. As versões ultrapassam as faixas declaradas pelos
consumidores: `npm run test:metadata-compat` verifica em loopback a detecção,
a resposta e o erro 404 do detector, e o CI valida migrations e a imagem de
migração. Remova os overrides quando as dependências oficiais incorporarem as
correções.
