# Contratos de mensagens v1

Contratos em construção. O envelope define IDs de correlação e operação,
contexto da OS e versão local do agregado produtor. `billing.payment-confirmed`
é o primeiro tipo descrito; os demais comandos e fatos do plano ainda precisam
de schemas, exemplos e testes de compatibilidade produtor/consumidor.

Não enviar CPF, secrets ou connection strings. Alterações aditivas devem
preservar v1; mudanças incompatíveis exigem nova versão e convivência.
