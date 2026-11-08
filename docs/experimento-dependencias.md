# Experimento de dependências de Billing

Esta branch é experimental e não foi incorporada à branch de implementação.
Os overrides fixam `@prisma/config > deepmerge-ts` em 8.0.2 e
`gcp-metadata > gaxios` em 8.3.2. Ambos ultrapassam as versões declaradas pelos
respectivos consumidores; revisar compatibilidade e acompanhar correções
oficiais antes de integrar. O projeto executa em Azure, mas o teste de loopback
verifica detecção, resposta e erro 404 do detector transitivo de metadados.

Na avaliação local com Node 24, `npm audit --omit=dev` retornou zero alertas;
o audit completo ainda apresentou sete baixos e oito moderados. Passaram geração
do Prisma, validação com configuração, migration, 209 testes unitários,
integração PostgreSQL, imagem de migração e 24 cenários BDD distribuídos com
Service Bus e Cosmos emulados. A integração com GCP real não foi verificada.
