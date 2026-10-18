# Sistema A: mock do GLPI (Node.js + JavaScript)

A **fonte da verdade** dos chamados. Imita o comportamento do GLPI que importa para a sincronização:

- status 1–6 (Novo → Fechado), prioridade 1–6, categoria, localização;
- `date_mod` **sem fuso**, no horário local do servidor (`A_TIMEZONE`), como no GLPI real; não existe campo de versão;
- acompanhamentos (ITILFollowup) e soluções com aprovação (ITILSolution): status 5 = Solucionado (congelado);
- perfis: **Técnico** (tudo), **Estagiário** (só ver e abrir), **sync-bot** (usuário técnico do sync);
- webhook `ticket.changed` assinado com HMAC, que pode "perder" eventos de propósito (`A_WEBHOOK_DROP_RATE`).

Contrato: [`contracts/system-a.openapi.yaml`](../../contracts). Issues: épico **E1**.

<!-- test-ci-system-a -->
