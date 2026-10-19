# Roteiro da demo (30 min)

Roteiro da apresentação e do vídeo de backup (#69). Mesma ordem nos dois: o vídeo é este roteiro gravado.

**URLs de produção** (credenciais só no e-mail da entrega):

| | |
|---|---|
| Sistema A (o central, como o GLPI) | https://a.150-230-231-210.sslip.io/ui/ |
| Sistema B (caixa-preta instável) | https://b.150-230-231-210.sslip.io/ui/ |
| Dashboard do sync (fila, DLQ, caos) | https://sync.150-230-231-210.sslip.io/dashboard |

**Antes de começar (5 min antes):** abrir as três abas lado a lado; entrar no A como Técnico; no B, preencher "Seu nome" com `Carla (suporte)`; no dashboard, clicar em **Desligar tudo** (caos zerado); conferir `https://sync.…/ready` respondendo 200. Ter um terminal com o repositório e o compose local pronto (plano B).

| Tempo | Bloco | Plano B |
|---|---|---|
| 0–3 | O problema | slide/README |
| 3–10 | O A é a tela de trabalho | compose local |
| 10–17 | Caos ao vivo | `npm run e2e` ao vivo |
| 17–22 | B → A e quem manda em cada mudança | E2E F4 e H1 |
| 22–26 | Como foi provado | run da CI já verde |
| 26–30 | Decisões, fora do escopo, perguntas | — |

## 0–3 · O problema

- **Fala:** "O A é o nosso sistema de chamados, como o GLPI. O B é de outra empresa: outra API, outro formato, lento e às vezes mente. O sync mantém o B atualizado com três proibições: **nunca duplicar, nunca perder, nunca sobrescrever com dado velho**."
- Mostrar o diagrama do README (A → webhook/poller → fila no Postgres → worker → B).
- **Frase-chave:** "O B é caixa-preta: o único contrato que assumo é criar, ler, atualizar e listar. Todo o resto o sync resolve sozinho."

## 3–10 · O A é a tela de trabalho

1. No A, **Novo chamado**: "Impressora do 3º andar não imprime", categoria *Hardware > Impressão*, local, requerente. **Criar.**
2. No B, **Atualizar**: o registro aparece com categoria, local e requerente em texto e o marcador `⟦s:glpi-<id>⟧` no fim da descrição.
   - **Fala:** "O marcador é a idempotência: o B não tem chave de idempotência nem busca, então a identidade do chamado mora no próprio dado."
3. No detalhe do A, o cartão **Ações**: **Atribuir a mim** → no B, `assignee` e *Em andamento*.
4. Escrever a solução e **Solucionar** → a solução vira nota no A; no B, *Resolvido*. **Fechar** → *Fechado*. **Reabrir** → volta a *Em andamento* e o A limpa as datas, como o GLPI.
5. No dashboard, os jobs `done` e o mapeamento `A #id ↔ B-n`.
6. (30 s) Sair e entrar como **Estagiário**: abre e lê, mas não vê as ações; **Editar** responde 403 com a frase.

**Plano B:** `docker compose -f infra/docker-compose.yml --env-file .env up -d --build --wait` e o mesmo fluxo em `localhost:3001/ui/` e `localhost:5002/ui/`.

## 10–17 · Caos ao vivo

1. Dashboard → painel **Caos do Sistema B**: *erro 5xx* `0.5`, *grava e falha* `0.2`, *ack sem gravar* `0.2` → **Aplicar**.
   - **Fala:** "Metade das chamadas falha; 20% gravam e respondem erro (o retry ingênuo duplicaria); 20% respondem sucesso sem gravar (o ingênuo perderia)."
2. No A, criar **5 chamados** e editar o título de 2 deles.
3. No dashboard: a fila cresce, retries com backoff, o disjuntor abre e fecha. **A DLQ continua vazia.**
4. **Desligar tudo** → a fila drena em segundos.
5. No B, contar: **cada chamado uma vez**, com o título editado.
   - **Fala:** "Grava-e-falha: o create é ambíguo, então o sync procura o marcador antes de recriar. Ack-sem-gravar: o sync relê o B depois de cada escrita e só grava o hash se o B gravou de verdade."

**Plano B:** caos sem efeito visível → rodar `npm run e2e` ao vivo (o primeiro cenário cria 20 chamados e edita 5 sob caos agressivo e confere que cada um chega uma vez, com a última versão).

## 17–22 · B → A e quem manda em cada mudança

1. No B, abrir o registro do chamado do bloco 2 → **Fechar** com a solução "Toner trocado".
2. Em até 30 s, no A: status *Fechado* e a nota "Estado alterado no Sistema B por Carla (suporte)… Solução: Toner trocado."
   - **Fala (anti-eco):** "Isso não volta para o B: o que o sync escreveu tem o hash que ele mesmo gravou, e o A não dispara webhook para o sync-bot."
3. No B, mudar o **título** e salvar → em 30 s o título volta e o A ganha a nota "o A é a fonte da verdade e o valor foi restaurado".
4. **Excluir** no B outro chamado → no A, ele vai para a **lixeira** com "Excluído no Sistema B por Carla (suporte) em …". No A, **Ver lixeira** → **Restaurar** → o registro volta ao B (novo ID, sem duplicar).
5. **Fala (os dois ao mesmo tempo):** "Se o A e o B mudam o estado juntos, o A vence e registra o que o B tinha feito. Se o B exclui mas o A mudou o chamado depois, o A vence e recria."
6. Mostrar a tabela "quem é o mestre" (ADR-015): criar e campos → A; status → quem mudou desde a última sincronização (os dois → A); quem alterou e solução → B (vira nota); excluir → o A decide (lixeira reversível).

**Plano B:** os E2E `f4-b-fecha-volta-ao-a-sem-eco` e `h1-exclusao-nos-dois-lados`.

## 22–26 · Como foi provado

- GitHub Actions → último run da CI verde: testes do A, do B (xUnit), do sync (unitários + integração com Postgres) e o job **e2e**: 13 cenários com os três sistemas de verdade, o caos ligado e containers derrubados (A1 commit-then-fail, A2 timeout com gravação tardia, B1 B fora, B3 sync derrubado no meio do job…).
- **Um exercício de quebra ao vivo** (`docs/how-it-works.md`, seção 10): apagar a busca pelo marcador (`scanForMarker` devolve `null`) e rodar `process-job.test.ts` → 7 testes falham com duplicata. Desfazer com `git checkout -- src`.

## 26–30 · Decisões, fora do escopo, perguntas

- **Decisões (cada uma com o ADR):** contrato mínimo do B (003), marcador no dado (004), o evento é sinal e o worker relê o A (005), fila no Postgres com `SKIP LOCKED` (002), verificação pós-escrita, transitório × permanente com DLQ de 24 h e disjuntor (008), B → A leve (014), exclusão nos dois lados (015).
- **Fora do escopo** (`docs/out-of-scope.md`): aprovação do Técnico e congelamento (ADR-006), notas A → B, anexos, auditoria append-only com linha do tempo.
- **Horas:** total no `docs/timelog.md`, pelos registros do GitHub.

**Fim do ensaio:** dashboard → **Desligar tudo** (caos zerado para o avaliador).
