# Mapeamento de campos · Sistema A (GLPI) → Sistema B

> Detalha a seção 9 do `PLANO_DE_ACAO.md`, os ADRs [004](adr/004-marcador-no-dado-e-teste-de-capacidade.md) (marcador), [005](adr/005-evento-e-sinal-date-mod-e-hash-utc.md) (data em UTC + hash de conteúdo) e [009](adr/009-anti-eco.md) (anti-eco), e os contratos `contracts/system-a.openapi.yaml` (`Ticket`) e `contracts/system-b.openapi.yaml` (`RecordInput`, `Record`).
>
> Implementação pura (sem I/O) em `apps/sync-service/src/domain/`.

## 1. Visão geral (campo a campo)

| Campo no A (`GlpiTicket`) | Campo no B (`RecordInput`) | Transformação |
|---|---|---|
| `id` (`integer >= 1`) | fim de `description` (ou `title`) | Marcador `⟦s:glpi-<id>⟧` anexado por `appendMarker(text, markerFor(id))` (ADR-004) |
| `name` (`string`, 1..255) | `title` (`string`, 1..200) | Neutraliza `⟦` e `⟧` → `[` e `]`, colapsa espaços internos, faz `trim` e corta em até **200 code points** sem partir grafemas (`Intl.Segmenter`) |
| `content` (HTML) | `description` (texto puro) | `htmlToText` remove scripts/estilos/tags, decodifica entidades, remove caracteres de controle, neutraliza `⟦`/`⟧` e anexa `\n\n⟦s:glpi-<id>⟧` |
| `status` (`1..6`) | `state` (`State`) | Tabela `STATUS_TO_STATE` (`toState`) |
| `priority` (`1..6`) | `severity` (`Severity`) | Tabela `PRIORITY_TO_SEVERITY` (`toSeverity`) |
| `itilcategories_id` (`int \| null`) | `category` (`string \| null`) | Nome completo da categoria no catálogo do A (`GET /ITILCategory`, ex.: "Hardware > Impressão"); ausente ou sem entrada → `null` |
| `users_id_recipient` (`int \| null`) | `requester` (`string \| null`) | "Nome Sobrenome (login)" do usuário no A (`GET /User`); ausente ou sem entrada → `null` |
| `users_id_assign` (`int \| null`) | `assignee` (`string \| null`) | Mesmo formato do requerente; ausente ou sem entrada → `null` |
| `locations_id` (`int \| null`) | `location` (`{ name, lat, lng } \| null`) | Local do catálogo do A (`GET /Location`) com `latitude`/`longitude` → `lat`/`lng`; sem coordenadas → `null`; ausente ou sem entrada → `null` |
| `date_mod` (`YYYY-MM-DD HH:MM:SS`) | `sourceUpdatedAt` (`YYYY-MM-DDTHH:MM:SSZ`) | Interpretado no fuso `A_TIMEZONE` e convertido para UTC por `glpiLocalToUtc` |
| `attachments` (`[{ name, size, sha256 }]`) | `attachments` (`[{ name, size, sha256 }]`) | Cópia defensiva apenas dos 3 campos de metadados (sem binário) |
| `date`, `solvedate`, `closedate` | — | Não enviados no `RecordInput` e fora do `hashTicket` |

> **De onde vêm os nomes:** o sync lê os catálogos do A (`ITILCategory`, `User`, `Location`) como `sync-bot` e guarda em cache por `A_LOOKUPS_TTL_MS` (60 s); a conversão continua pura no `mapTicketToRecord` (`lookups`). Renomear um item do catálogo não reenvia os chamados antigos (o hash é calculado sobre os IDs do A): o novo nome chega ao B na próxima alteração do chamado.

## 1.5 B → A leve: estado do B → status do A (ADR-014)

| `state` no B | `status` no A | Observação |
|---|---|---|
| `OPEN` | `1` Novo | reabertura no B |
| `IN_PROGRESS` | `2` Em atendimento | |
| `ON_HOLD` | `4` Pendente | |
| `RESOLVED` | `5` Solucionado | o A grava a `solvedate` |
| `CLOSED` | `6` Fechado | o A grava a `closedate` |

Ida e volta batem com a tabela A → B (`toState(toGlpiStatus(s)) === s`), então o chamado não oscila. Quem alterou (`updatedBy`) e a solução (`resolution`) do B vão para a nota do `sync-bot` no A. A solução é um campo do B: o sync a preserva ao atualizar o registro.

## 2. Tabelas de status e prioridade (cenário G1)

### 2.1 `status` (A) → `state` (B)

| `status` no A (GLPI) | Significado no GLPI | `state` no B | Justificativa |
|---|---|---|---|
| `1` | Novo | `OPEN` | Chamado recém-aberto aguardando atendimento |
| `2` | Em atendimento (atribuído) | `IN_PROGRESS` | Já em tratamento pelo técnico |
| `3` | Planejado | `IN_PROGRESS` | No GLPI, Planejado significa atribuído e agendado (já em tratamento) |
| `4` | Pendente | `ON_HOLD` | Aguardando terceiro ou janela |
| `5` | Solucionado | `RESOLVED` | O Técnico solucionou no A |
| `6` | Fechado | `CLOSED` | Encerrado no A |

> **5 e 6 são atualizações como as outras.** O A é o sistema central (PDF): o Técnico soluciona e fecha no A, e o B reflete `RESOLVED` ou `CLOSED`. A regra "5 e 6 só via aprovação" (ADR-006) e o congelamento pertencem ao B → A opcional, não implementado (ADR-013).

### 2.2 `priority` (A) → `severity` (B)

| `priority` no A | `severity` no B |
|---|---|
| `1`, `2` | `LOW` |
| `3` | `MEDIUM` |
| `4` | `HIGH` |
| `5`, `6` | `CRITICAL` |

Qualquer valor fora de `1..6` (ou não inteiro) em `status` ou `priority` lança `MappingError` (`permanent = true`).

## 3. Regras de título (`normalizeTitle`)

1. **Neutralização de delimitadores do marcador:** qualquer `⟦` vira `[` e qualquer `⟧` vira `]` antes de processar o título.
2. **Espaços:** sequências de whitespace (`\s+`) viram um único espaço `' '` e o texto sofre `trim()`.
3. **Vazio após trim:** lança `MappingError` (`field: 'name'`). Um título só de espaços nunca passaria no schema do B (`minLength: 1`), então falha imediatamente como erro permanente sem gastar tentativas de rede.
4. **Corte em 200 code points sem partir grafema (cenário G3):** o JSON Schema (`maxLength: 200`) conta code points Unicode, mas cortar no meio de uma sequência ZWJ (como `👨‍👩‍👧`, que tem 5 code points e 1 grafema) corromperia o caractere. `truncateByGraphemeCodePoints` percorre `Intl.Segmenter` (`granularity: 'grapheme'`) somando os code points de cada grafema e para antes de ultrapassar o limite.
5. **Quando `markerField === 'title'`:** reserva `codePoints(marker) + 1` (espaço + `⟦s:glpi-<id>⟧`) para que o título final com marcador nunca ultrapasse 200 code points.

## 4. Conversão de HTML para texto seguro (`htmlToText`, cenários G2 e G3)

O Sistema A armazena `content` em HTML; o Sistema B recebe texto puro em `description`. `htmlToText` aplica, em tempo linear $O(n)$ (sem regex com backtracking aninhado, suportando descrições de 100 KB+):

1. Normaliza quebras `\r\n` e `\r` para `\n`.
2. Remove comentários HTML (`<!-- ... -->`) e declarações (`<!DOCTYPE ...>`, `<![CDATA[...]]>`), inclusive se truncados no fim.
3. Remove blocos `<script>...</script>`, `<style>...</style>` e `<head>...</head>` **junto com todo o seu conteúdo** (case-insensitive, mesmo se malformados/abertos).
4. Converte tags estruturais em quebras legíveis:
   - `<br>` / `<br/>` → `\n`
   - `<li>` → `- ` e `</li>` → `\n`
   - `</p>`, `</div>`, `</tr>`, `</h1>`..`</h6>` → `\n`
5. Remove todas as demais tags HTML (inclusive atributos como `onerror=...` ou `href="javascript:..."`) e quaisquer `<` ou `>` soltos remanescentes.
6. Decodifica entidades HTML em passagem única:
   - Nomeadas comuns (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&nbsp;`, `&copy;`, `&reg;`, `&ndash;`, `&mdash;`, `&hellip;`). Importante: como a remoção de tags ocorre **antes** da decodificação, `&lt;script&gt;` vira o texto literal `<script>` e nunca é interpretado como tag.
   - Numéricas decimais (`&#65;`) e hexadecimais (`&#x41;`). Code points inválidos (`0`, surrogates `0xD800..0xDFFF` ou `> 0x10FFFF`) viram `` (`U+FFFD`).
7. Remove caracteres de controle (`U+0000..U+001F` e `U+007F..U+009F`), preservando apenas `\n` e `\t`.
8. Colapsa espaços/tabs em cada linha, remove espaços nas pontas de cada linha, reduz 3+ quebras seguidas para no máximo 1 linha em branco (`\n\n`) e faz `trim()` final.

## 5. Marcador de idempotência e neutralização (ADR-004)

- **Formato:** `markerFor(aId)` gera `⟦s:glpi-<aId>⟧` (ex.: `⟦s:glpi-42⟧`).
- **Neutralização (`neutralizeMarkers`):** antes de anexar o marcador verdadeiro, qualquer `⟦` ou `⟧` vindo do título ou descrição do A é trocado por `[` ou `]`. Isso impede que um usuário digite `⟦s:glpi-99⟧` no chamado 42 e engane a varredura de reconciliação (`create_uncertain`).
- **Anexação (`appendMarker`):**
  - Em `description` (padrão): `texto + "\n\n" + marcador` (ou só `marcador` se a descrição ficou vazia).
  - Em `title` (`B_MARKER_FIELD=title`): `títuloCortado + " " + marcador`.
- **Extração (`findMarker`):** lê apenas o marcador `⟦s:glpi-(\d+)⟧` no **final** do texto (`\s*$`), devolvendo o ID numérico positivo ou `null`.

## 6. Hash canônico (`hashTicket` e `hashRecord`, ADR-005, C6, F3)

Ambos calculam `SHA-256` em hex minúsculo sobre `"v1:" + canonicalJson(campos)`.
- `canonicalJson` ordena recursivamente as chaves de objetos, converte `undefined` em `null` e preserva a ordem dos arrays.
- O prefixo `v1:` garante que, se a lista de campos sincronizáveis mudar no futuro, basta incrementar o prefixo para forçar ressincronização sem risco de falso "igual".

### 6.1 Campos incluídos e excluídos em `hashTicket` (Sistema A)

- **Incluídos (`SYNCABLE_TICKET_FIELDS`):** `name`, `content`, `status`, `priority`, `itilcategories_id`, `locations_id`, `users_id_recipient`, `users_id_assign`, `attachments` (`name`, `size`, `sha256`).
- **Excluídos de propósito:**
  - `date_mod`: quando o `sync-bot` adiciona uma nota no A, o GLPI atualiza `date_mod` do chamado sem mudar os campos sincronizáveis. Ignorar `date_mod` faz o hash continuar idêntico a `last_synced_hash`, virando no-op e cortando o eco A↔B (Q22, ADR-005, ADR-009).
  - `id` e `date`: metadados fixos de criação do chamado.
  - `solvedate` e `closedate`: derivados das transições de `status` (5 e 6), que já entram no hash.

### 6.2 Campos incluídos e excluídos em `hashRecord` (Sistema B)

- **Incluídos (`SYNCABLE_RECORD_FIELDS`):** `title`, `description`, `state`, `severity`, `category`, `requester`, `assignee`, `location` (`name`, `lat`, `lng`), `attachments` (`name`, `size`, `sha256`).
- **Excluídos de propósito:**
  - `sourceUpdatedAt`: representa o `date_mod` do A.
  - `id`, `createdAt`, `updatedAt`, `updatedBy`: metadados e relógio do Sistema B (não confiável, ADR-003 e cenário C6). Assim, `hashRecord(recordInputEnviado)` é idêntico a `hashRecord(recordLidoDoB)` logo após a escrita (`last_written_hash`, cenário F3).

## 7. Fuso horário e horário de verão (`time.ts`, ADR-005, cenário B11)

O Sistema A grava `date_mod` como `YYYY-MM-DD HH:MM:SS` sem offset, no fuso configurado em `A_TIMEZONE` (padrão `America/Sao_Paulo`).

1. **`glpiLocalToUtc(glpiDateTime, timeZone)`:** converte para ISO UTC sem milissegundos (`YYYY-MM-DDTHH:MM:SSZ`).
   - **Hora repetida (volta do horário de verão / *fall back*):** quando o relógio local recua (ex.: `01:30` ocorre duas vezes em `America/New_York` em `2026-11-01` ou `23:30` em `America/Sao_Paulo` em `2019-02-16`), adota a política `compatible` (Temporal): escolhe a **primeira ocorrência** (offset de verão).
   - **Hora inexistente (ida do horário de verão / *spring forward*):** quando o relógio local pula uma hora (ex.: `02:30` em `2026-03-08` em `America/New_York` ou `00:30` em `2018-11-04` em `America/Sao_Paulo`), avança pela duração do salto usando o offset anterior à transição (`03:30` no novo offset), sem lançar exceção.
2. **`utcToGlpiLocal(instant, timeZone)`:** formata um instante UTC como `YYYY-MM-DD HH:MM:SS` no fuso `timeZone` (`hourCycle: 'h23'`).
3. **`pollLowerBoundLocal(fromUtc, toUtc, timeZone)` (cenário B11):** calcula o valor de `date_mod_gte` para o poller do A.
   - Na volta do horário de verão, o relógio local anda para trás: um chamado modificado às `06:10Z` (`01:10` EST, 2ª ocorrência) tem `date_mod` lexicograficamente menor que o checkpoint `05:56Z` (`01:56` EDT, 1ª ocorrência).
   - Para nunca pular chamados na hora repetida, `pollLowerBoundLocal` amostra o offset de `timeZone` em `fromUtc`, `toUtc` e a cada 24 h no intervalo, pega o **menor offset** encontrado e aplica esse menor offset ao instante `fromUtc`. Na volta do DST, o filtro recua 1 h extra (relendo chamados cujo hash já bate com `last_synced_hash`, portanto no-op sem escrita no B).

## 8. Erros permanentes do domínio (`MappingError`)

`MappingError` possui `readonly permanent = true`, `field` e `value` (a mensagem do erro nunca ecoa conteúdo longo do chamado). O worker/fila (S3.3/S3.5) classifica `MappingError` como falha permanente e envia direto para a DLQ sem gastar 24 h de retry. Dispara quando:

- `id` do chamado não é inteiro positivo (`markerFor`);
- `status` ou `priority` está fora de `1..6` (`toState`, `toSeverity`);
- `name` fica vazio após trim/neutralização ou não cabe no limite (`normalizeTitle`);
- `date_mod` não obedece ao formato `YYYY-MM-DD HH:MM:SS` ou representa uma data inexistente como `2026-02-29` (`glpiLocalToUtc`);
- `instant` inválido ou `toUtc < fromUtc` (`utcToGlpiLocal`, `pollLowerBoundLocal`).
