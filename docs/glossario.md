# Glossário

As siglas e os termos usados no projeto, em linguagem simples. Os detalhes de cada mecanismo estão em [`how-it-works.md`](how-it-works.md) e nos [ADRs](adr/).

## Os sistemas

| Termo | O que é |
|---|---|
| **Sistema A** | O sistema de chamados, que imita o GLPI. É a fonte da verdade: o chamado nasce e é trabalhado nele |
| **GLPI** | Sistema de chamados de código aberto, muito usado em TI. O PDF pede que o A siga o GLPI |
| **Sistema B** | O sistema externo, de um terceiro, que recebe os chamados. É instável de propósito: fica lento, dá erro e às vezes responde "ok" sem gravar |
| **Caixa-preta** | Não se sabe como o B funciona por dentro; só se usa o que ele oferece por fora: criar, ler, atualizar e listar |
| **Sync (Sync Service)** | O serviço de sincronização, o foco do desafio. Fica entre o A e o B e leva cada mudança do A para o B |
| **Mock** | Uma imitação simplificada de um sistema real. O A e o B deste projeto são mocks |
| **Dashboard** | O painel do sync: mostra a fila, a DLQ e a atividade, e liga ou desliga o caos do B |

## As três garantias

| Termo | O que é |
|---|---|
| **Duplicata** | O mesmo chamado aparecer duas vezes no B |
| **Atualização perdida** | Uma mudança feita no A nunca chegar ao B |
| **Dado velho sobre novo** | Uma versão antiga do chamado apagar uma mais nova no B |
| **Marcador** `⟦s:glpi-<id>⟧` | Uma etiqueta gravada no fim da descrição do registro no B que diz de qual chamado do A ele veio. Quando não se sabe se um registro foi criado, o sync procura a etiqueta antes de criar de novo |
| **Idempotência** | Fazer a mesma coisa duas vezes dá o mesmo resultado que fazer uma vez. É o que impede a duplicata |
| **Hash** | Uma impressão digital do conteúdo. Se ela não mudou, o chamado não mudou e não há nada a enviar |

## Como o sync trabalha

| Termo | O que é |
|---|---|
| **Webhook** | O aviso que o A manda na hora: "o chamado 42 mudou" |
| **HMAC** | A assinatura do aviso, que prova que ele veio do A e não foi forjado |
| **Anti-replay** | Recusar um aviso antigo reenviado (fora da janela de 5 min) |
| **Poller** | A rede de segurança do webhook: de tempos em tempos o sync pergunta ao A o que mudou |
| **Fila / job** | Cada chamado a sincronizar vira uma tarefa (job) numa fila guardada no Postgres |
| **Worker** | A parte do sync que pega os jobs da fila e executa |
| **SKIP LOCKED / lease** | Recursos para dois workers nunca pegarem o mesmo chamado ao mesmo tempo. O lease é um empréstimo com prazo: se o sync cair no meio, o job volta para a fila |
| **Retry / backoff** | Tentar de novo depois de um erro, esperando cada vez mais entre as tentativas (até 24 h) |
| **DLQ** (*Dead Letter Queue*) | A fila de problemas: jobs que falharam de vez e esperam uma pessoa. Dá para reprocessar pelo dashboard |
| **Disjuntor** (*circuit breaker*) | Se o B falha muito, o sync para de chamá-lo por um tempo, como um disjuntor elétrico |
| **Transitório × permanente** | Erro passageiro (B fora, lentidão) tenta de novo; erro definitivo (dado inválido) vai para a DLQ |
| **Verificação pós-escrita** | Depois de gravar no B, o sync lê de volta para conferir, porque o B pode dizer "ok" sem ter gravado |
| **create_uncertain** | O estado "criei, mas não sei se gravou". O sync procura o marcador antes de tentar de novo |
| **Mapeamento** (`ticket_mapping`) | A tabela que liga um chamado do A ao registro dele no B |
| **Reconciliação pelo marcador** | Na subida, o sync refaz os mapeamentos lendo os marcadores que já estão no B. Protege contra a perda do banco do sync |

## B → A (o opcional do avaliador)

| Termo | O que é |
|---|---|
| **A → B** | O sentido obrigatório: o que muda no A vai para o B |
| **B → A leve** | O opcional: quando o operador do B resolve, fecha ou reabre, isso volta ao A com uma nota de quem fez e da solução |
| **Anti-eco** | Impede que uma mudança fique indo e voltando entre A e B. O sync reconhece o que ele mesmo escreveu (`last_written_hash`) |
| **sync-bot** | O usuário que o sync usa para entrar no A. Só pode mudar o status e mandar para a lixeira |
| **Varredura do B** | A cada 30 s o sync percorre o B para ver o que o operador mudou, porque o B não avisa ninguém |
| **O A vence** | Se A e B mudam o mesmo chamado ao mesmo tempo, vale o que está no A |
| **Lixeira / lápide** | Excluir no A é reversível (lixeira). No B, o excluído vira uma lápide: responde 410 ("foi excluído"), diferente de 404 ("não existe") |

## Modo caos

| Termo | O que é |
|---|---|
| **Caos** | Defeitos que o B finge ter, de propósito, para provar que o sync aguenta. Liga e desliga pelo dashboard |
| **Latência** | O B demora para responder |
| **5xx** | O B responde "deu erro" |
| **Timeout** | O B não responde a tempo, e às vezes grava depois |
| **Grava e falha** (*commit-then-fail*) | O B grava, mas responde que deu erro: a armadilha clássica da duplicata |
| **Ack sem gravar** | O B responde "ok" e não grava nada |
| **429** (*rate limit*) | O B pede calma: muitas requisições |
| **Listagem instável** | A lista do B repete ou pula páginas |
| **Seed** | Um número fixo que faz o caos repetir as mesmas falhas, para o teste ser reproduzível |

## Testes

| Termo | O que é |
|---|---|
| **E2E** (*end-to-end*, ponta a ponta) | Teste que sobe os três sistemas de verdade, com o caos ligado, e confere o resultado final no B. São 14 |
| **Teste unitário** | Testa uma peça pequena isolada, como a conversão de status |
| **Teste de integração** | Testa o sync conversando com um banco Postgres de verdade |
| **Cenários A1, B3, C1…** | Os casos do catálogo. A: duplicatas · B: perda · C: dado velho · D: aprovação · E: B hostil · F: eco · G: conversão de dados · H: segurança |
| **xUnit** | A ferramenta de testes do B (.NET) |

## Códigos HTTP

| Código | Significado |
|---|---|
| **200 / 201** | Ok / criado |
| **401** | Sem login ou credencial inválida |
| **403** | Logado, mas sem permissão (por exemplo, o Estagiário tentando editar) |
| **404** | Não encontrado |
| **409** | Conflito (por exemplo, editar um chamado que está na lixeira) |
| **410** | Excluído (a lápide do B) |
| **422** | Dado inválido (por exemplo, título vazio) |

## Infra e entrega

| Termo | O que é |
|---|---|
| **CI** (*Continuous Integration*) | Os testes que rodam sozinhos no GitHub a cada PR |
| **CD / deploy** | Publicar a versão nova no servidor. Aqui é automático a cada merge na `Prod` |
| **PR** (*Pull Request*) | O pedido para juntar uma branch em outra, revisado antes |
| **`Dev` / `Prod`** | `Dev` é homologação (só roda os testes); `Prod` é o que está publicado |
| **Release** | O PR de `Dev` para `Prod` que leva tudo para o ar |
| **VM** | A máquina virtual na Oracle Cloud (gratuita) onde tudo roda |
| **Docker / Compose** | Cada sistema roda num container; o Compose sobe todos juntos com um comando |
| **Caddy / HTTPS / Let's Encrypt** | O servidor na frente que dá o cadeado HTTPS, com certificado gratuito do Let's Encrypt |
| **sslip.io** | Serviço que dá um nome ao IP do servidor (`a.150-230-231-210.sslip.io`) |
| **GHCR** | O registro de imagens Docker do GitHub, de onde a VM baixa a versão nova |
| **Smoke test / rollback** | Teste rápido depois do deploy / voltar para a versão anterior se der errado |
| **/health, /ready** | Endereços que dizem se o serviço está vivo e se as dependências (banco, A e B) estão de pé |
| **Postgres / SQLite** | Os bancos de dados: o sync usa Postgres (fila, mapeamentos, auditoria); o A e o B usam SQLite |
| **PITR / WAL** | Recursos de backup do Postgres para voltar o banco a um momento exato. Ficaram fora do escopo |
| **OpenAPI / contrato** | A descrição formal das APIs do A e do B, em `contracts/` |
| **audit_log / correlation_id** | O registro técnico do que o sync fez, e o código que liga todos os logs de uma mesma operação |

## Organização do trabalho

| Termo | O que é |
|---|---|
| **ADR** (*Architecture Decision Record*) | Um documento curto por decisão: o que foi decidido e por quê. São 15 |
| **Épico (E0–E9)** | Um bloco grande de trabalho |
| **Story (S1.1…)** | Uma tarefa dentro de um épico |
| **Milestone (M0–M5)** | Uma etapa do projeto |
| ***Not planned* / fora do escopo** | Ficou para depois de propósito, com o motivo e o desenho registrados |
| **Timelog** | O registro de horas |
| **Mermaid** | A linguagem que desenha os diagramas dentro da documentação |

## Termos do GLPI e do domínio

| Termo | O que é |
|---|---|
| **Técnico / Estagiário** | Os perfis do A. O Técnico trabalha o chamado; o Estagiário abre e consulta |
| **ITILFollowup** | O nome do GLPI para "acompanhamento", a nota na conversa do chamado |
| **date_mod** | A data da última alteração do chamado no GLPI |
| **Fuso / UTC** | O A grava no horário de São Paulo; o sync guarda tudo em UTC, o horário universal |
| **SLA, TTO, TTR** | Prazos de atendimento: até o primeiro atendimento (TTO) e até resolver (TTR). Ficaram fora do escopo |
| **If-Match / ETag** | Mecanismo para o B recusar uma escrita sobre uma versão velha. Ficou fora, porque o B não oferece |
