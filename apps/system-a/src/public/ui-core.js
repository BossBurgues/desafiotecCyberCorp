// Lógica pura da UI do Sistema A: sem DOM e sem fetch.
// O navegador e o `node --test` importam este mesmo arquivo.

export const PROFILES = Object.freeze({
  TECNICO: 'tecnico',
  ESTAGIARIO: 'estagiario',
  SYNC_BOT: 'sync-bot',
});

// IDs fixos do seed (S1.2).
export const SYNC_BOT_USER_ID = 3;

const PROFILE_LABELS = Object.freeze({
  [PROFILES.TECNICO]: 'Técnico',
  [PROFILES.ESTAGIARIO]: 'Estagiário',
  [PROFILES.SYNC_BOT]: 'sync-bot',
});

const STATUS_LABELS = Object.freeze({
  1: 'Novo',
  2: 'Em atendimento',
  3: 'Planejado',
  4: 'Pendente',
  5: 'Solucionado',
  6: 'Fechado',
});

const PRIORITY_LABELS = Object.freeze({
  1: 'Muito baixa',
  2: 'Baixa',
  3: 'Média',
  4: 'Alta',
  5: 'Muito alta',
  6: 'Crítica',
});

export function profileLabel(profile) {
  return PROFILE_LABELS[profile] ?? String(profile);
}

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? `Status ${status}`;
}

export function priorityLabel(priority) {
  return PRIORITY_LABELS[priority] ?? `Prioridade ${priority}`;
}

// O Técnico escolhe qualquer status do GLPI, inclusive Solucionado (5) e Fechado (6), como no GLPI.
export function editableStatuses() {
  return [1, 2, 3, 4, 5, 6];
}

// Rótulos dos catálogos do GLPI (ITILCategory, Location, User). "—" quando o chamado não tem o campo.
export function userLabel(user) {
  if (!user) {
    return '—';
  }
  const full = [user.firstname, user.realname].filter(Boolean).join(' ');
  return full ? `${full} (${user.name})` : user.name;
}

/** Nome curto para a tela ("Ana Souza"), sem o login. */
export function userName(user) {
  if (!user) {
    return null;
  }
  return [user.firstname, user.realname].filter(Boolean).join(' ') || user.name;
}

export function catalogLabel(list, id, labelOf = (item) => item.completename ?? item.name) {
  const item = id == null ? null : (list || []).find((x) => x.id === id);
  return item ? labelOf(item) : '—';
}

/** Iniciais para o avatar: "Ana Souza" → "AS", "Carla (suporte)" → "C". */
export function initials(name) {
  const words = String(name ?? '')
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?';
}

/** "2026-10-19 18:57:27" (fuso do A) → "19/10 · 18:57". */
export function shortDate(glpiDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(String(glpiDate ?? ''));
  return m ? `${m[3]}/${m[2]} · ${m[4]}:${m[5]}` : String(glpiDate ?? '');
}

/** Busca da lista: pelo número (#90 ou 90) ou por um trecho do título, sem acento nem caixa. */
export function matchesSearch(ticket, query) {
  const q = fold(query).replace(/^#/, '');
  if (!q) {
    return true;
  }
  return String(ticket.id) === q || fold(ticket.name).includes(q);
}

function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// A UI só esconde; quem decide é o servidor (403).
export function canAddNote(profile) {
  return profile === PROFILES.TECNICO;
}

export function canEdit(profile) {
  // O Estagiário vê o botão e recebe o 403 do servidor (D7): a regra fica visível na demo.
  return profile === PROFILES.TECNICO || profile === PROFILES.ESTAGIARIO;
}

// Cartão "Ações" do detalhe: a tela de trabalho do GLPI. Só o Técnico vê; o servidor confere de novo (403).
export function canAct(profile) {
  return profile === PROFILES.TECNICO;
}

export function canCreate(profile) {
  return profile === PROFILES.TECNICO || profile === PROFILES.ESTAGIARIO;
}

/**
 * Ações do chamado e se cada uma vale no estado atual (mesma regra da UI do B: o estado em que o chamado já está não
 * é oferecido; reabrir só em Solucionado/Fechado; na lixeira só restaurar). Cada ação diz o PUT que faz; "solve"
 * também grava a nota da solução antes. `primary` marca o próximo passo natural do atendimento.
 */
export function ticketActions(ticket, userId) {
  const { status } = ticket;
  const deleted = ticket.is_deleted === 1;
  const open = !deleted && status < 5;
  const mine = ticket.users_id_assign === userId;
  const assign = { users_id_assign: userId };
  if (status === 1) {
    assign.status = 2;
  }
  const primary = deleted ? 'restore' : status === 6 ? 'reopen' : status === 5 ? 'close' : mine ? 'solve' : 'assign';
  return [
    { id: 'assign', label: 'Atribuir a mim', enabled: open && !mine, input: assign },
    { id: 'progress', label: 'Em atendimento', enabled: open && status !== 2, input: { status: 2 } },
    { id: 'pending', label: 'Pendente', enabled: open && status !== 4, input: { status: 4 } },
    { id: 'solve', label: 'Solucionar', enabled: open, input: { status: 5 } },
    { id: 'close', label: 'Fechar', enabled: !deleted && status !== 6, input: { status: 6 } },
    { id: 'reopen', label: 'Reabrir', enabled: !deleted && status >= 5, input: { status: 2 } },
    { id: 'delete', label: 'Excluir', enabled: !deleted, danger: true },
    { id: 'restore', label: 'Restaurar', enabled: deleted, input: { is_deleted: 0 } },
  ].map((action) => ({ ...action, primary: action.id === primary && action.enabled }));
}

export function solutionNote(text) {
  return `Solução: ${String(text ?? '').trim()}`;
}

export function errorMessage({ status, code, message, profile, action } = {}) {
  if (status === 0 || code === 'NETWORK') {
    return 'Sistema A fora do ar. Tente de novo em instantes.';
  }
  switch (code) {
    case 'ERROR_RIGHT_MISSING':
      return `Seu perfil (${profileLabel(profile)}) não pode ${action || 'fazer esta ação'}. Peça a um Técnico.`;
    case 'ERROR_TICKET_DELETED':
      return 'O chamado está na lixeira: restaure antes de editar.';
    case 'ERROR_SESSION_TOKEN_INVALID':
    case 'ERROR_SESSION_TOKEN_MISSING':
      return 'Sua sessão expirou. Entre de novo.';
    case 'ERROR_GLPI_LOGIN':
      return 'Usuário ou senha incorretos.';
    default:
      break;
  }
  if (status === 400 && message) {
    return message;
  }
  if (code) {
    return `${message || 'Erro no Sistema A.'} (${code})`;
  }
  return message || `Erro inesperado no Sistema A (HTTP ${status}).`;
}

export function isSessionError(code) {
  return code === 'ERROR_SESSION_TOKEN_INVALID' || code === 'ERROR_SESSION_TOKEN_MISSING';
}

// Marcadores de idempotência do sync (⟦n:…⟧, ⟦from-b:…⟧, ⟦s:…⟧) não aparecem no histórico.
const MARKER_PATTERN = /⟦[^⟧]*⟧/g;
const FROM_B_PATTERN = /⟦from-b:[^⟧]*⟧/;

export function stripMarkers(text) {
  return String(text ?? '')
    .replace(MARKER_PATTERN, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

const ENTITIES = Object.freeze({
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
  '&amp;': '&',
});

// Converte o HTML do GLPI em texto puro. O resultado só vai para textContent:
// mesmo um "<script>" decodificado aqui nunca executa.
export function htmlToText(html) {
  let text = String(html ?? '');
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  text = text.replace(/<(script|style)\b[\s\S]*$/gi, '');
  text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])\s*>/gi, '\n');
  text = text.replace(/<[^>]*>/g, '');
  text = text.replace(/<[^>]*$/g, '');
  text = text.replace(/&(lt|gt|quot|#39|nbsp|amp);/g, (entity) => ENTITIES[entity]);
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- histórico de atividade ----------
// As notas do sync-bot são frases escritas pelo sync (process-job.ts). Aqui elas viram eventos com um tipo, um
// autor e um texto curto, para o histórico não ser um bloco corrido. Frase desconhecida aparece como nota comum.

const SYNC_PHRASES = [
  {
    re: /^Estado alterado no Sistema B por (.+?): (.+?) → (.+?)\.(?: Solução: ([\s\S]+))?$/,
    event: ([, who, from, to, solution]) => ({ type: 'state', tag: 'Estado alterado no B', who, text: `${from} → ${to}`, quote: solution ?? null }),
  },
  {
    re: /^O Sistema B também mudou o estado para (.+?) \(por (.+?)\), ao mesmo tempo que o A mudou para (.+?): prevaleceu o A\.$/,
    event: ([, b, who, a]) => ({ type: 'conflict', tag: 'Conflito: o A venceu', who, text: `O B mudou para ${b} e o A para ${a} ao mesmo tempo. Ficou o do A.` }),
  },
  {
    re: /^O Sistema B alterou (.+?) \(por (.+?)\); o A é a fonte da verdade e o valor foi restaurado\.$/,
    event: ([, fields, who]) => ({ type: 'reverted', tag: 'Edição desfeita', who, text: `Mudou ${fields} no B. O A é a fonte da verdade e restaurou o valor.` }),
  },
  {
    re: /^Excluído no Sistema B por (.+?)(?: em (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}))?: /,
    event: ([, who]) => ({ type: 'deleted', tag: 'Excluído no B', who, text: 'O chamado foi para a lixeira. Restaurar recria o registro no B.' }),
  },
  {
    re: /^O Sistema B excluiu o registro (\S+) \(por (.+?)(?: em [^)]+)?\), mas o chamado mudou no A/,
    event: ([, record, who]) => ({ type: 'conflict', tag: 'Exclusão no B desfeita', who, text: `O B excluiu o ${record}, mas o chamado mudou no A depois: o registro foi recriado.` }),
  },
];

function syncEvent(line) {
  for (const phrase of SYNC_PHRASES) {
    const m = phrase.re.exec(line);
    if (m) {
      return phrase.event(m);
    }
  }
  return { type: 'note', tag: null, who: null, text: line };
}

/**
 * Uma nota do histórico: quem (pessoa do A, operador do B ou o sincronizador), quando e os eventos dela.
 * `users` é o catálogo /User, para mostrar o nome da pessoa em vez do perfil.
 */
export function describeNote(followup, users = []) {
  const raw = String(followup?.content ?? '');
  const text = stripMarkers(raw);
  const when = shortDate(followup?.date);

  if (followup?.users_id === SYNC_BOT_USER_ID) {
    const events = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map(syncEvent);
    if (FROM_B_PATTERN.test(raw)) {
      const who = events.find((e) => e.who)?.who ?? 'Operador B';
      return { when, author: { kind: 'operador', name: who, role: 'Sistema B' }, events };
    }
    return { when, author: { kind: 'sync', name: 'Sincronizador', role: 'automático' }, events };
  }

  const user = (users || []).find((u) => u.id === followup?.users_id);
  const role = user?.profile === PROFILES.ESTAGIARIO ? 'Estagiário' : 'Técnico';
  const name = userName(user) ?? role;
  const solution = /^Solução: ([\s\S]+)$/.exec(text);
  const events = solution
    ? [{ type: 'solution', tag: 'Solução', who: null, text: solution[1].trim() }]
    : [{ type: 'note', tag: null, who: null, text }];
  return {
    when,
    author: { kind: role === 'Estagiário' ? 'estagiario' : 'tecnico', name, role },
    events,
    private: followup?.is_private === 1,
  };
}

/** Histórico em ordem de data ("YYYY-MM-DD HH:MM:SS" ordena como texto), o mais antigo primeiro. */
export function buildTimeline(followups = [], users = []) {
  return followups
    .map((f, order) => ({ f, order }))
    .sort((a, b) => (a.f.date === b.f.date ? a.order - b.order : a.f.date < b.f.date ? -1 : 1))
    .map(({ f }) => describeNote(f, users));
}
