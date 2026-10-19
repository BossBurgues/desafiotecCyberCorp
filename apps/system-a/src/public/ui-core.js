// Lógica pura da UI do Sistema A (S1.6): sem DOM e sem fetch.
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

const USER_LABELS = Object.freeze({ 1: 'Técnico', 2: 'Estagiário', 3: 'sync-bot' });

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

const SOLUTION_STATUS_LABELS = Object.freeze({ 2: 'pendente', 3: 'aceita', 4: 'recusada' });

export function profileLabel(profile) {
  return PROFILE_LABELS[profile] ?? String(profile);
}

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? `Status ${status}`;
}

export function priorityLabel(priority) {
  return PRIORITY_LABELS[priority] ?? `Prioridade ${priority}`;
}

export function solutionStatusLabel(status) {
  return SOLUTION_STATUS_LABELS[status] ?? `status ${status}`;
}

// O Técnico escolhe qualquer status do GLPI, inclusive Solucionado (5) e Fechado (6). O fluxo de aprovação vindo
// do B (Q26) ficou fora do escopo na revisão de 18/10, então o A volta a fechar chamados sozinho, como no GLPI.
export function editableStatuses() {
  return [1, 2, 3, 4, 5, 6];
}

// A UI só esconde; quem decide é o servidor (403).
export function canDecide(profile) {
  return profile === PROFILES.TECNICO;
}

export function canAddNote(profile) {
  return profile === PROFILES.TECNICO;
}

export function canEdit(profile) {
  // O Estagiário vê o botão e recebe o 403 do servidor (D7): a regra fica visível na demo.
  return profile === PROFILES.TECNICO || profile === PROFILES.ESTAGIARIO;
}

export function canCreate(profile) {
  return profile === PROFILES.TECNICO || profile === PROFILES.ESTAGIARIO;
}

export function errorMessage({ status, code, message, profile, action } = {}) {
  if (status === 0 || code === 'NETWORK') {
    return 'Sistema A fora do ar. Tente de novo em instantes.';
  }
  switch (code) {
    case 'ERROR_RIGHT_MISSING':
      return `Seu perfil (${profileLabel(profile)}) não pode ${action || 'fazer esta ação'}. Peça a um Técnico.`;
    case 'ERROR_TICKET_FROZEN':
      return 'Chamado congelado (Solucionado ou Fechado): só aceita notas. A edição não foi salva.';
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

// Marcadores de idempotência do sync (⟦n:…⟧, ⟦from-b:…⟧, ⟦s:…⟧) não aparecem na conversa.
const MARKER_PATTERN = /⟦[^⟧]*⟧/g;
const FROM_B_PATTERN = /⟦from-b:[^⟧]*⟧/;

export function stripMarkers(text) {
  return String(text ?? '')
    .replace(MARKER_PATTERN, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export function authorOf(followup) {
  const usersId = followup?.users_id;
  if (usersId === SYNC_BOT_USER_ID) {
    if (FROM_B_PATTERN.test(String(followup?.content ?? ''))) {
      return { icon: '🏢', label: 'Operador B' };
    }
    return { icon: '🤖', label: 'sync-bot' };
  }
  return { icon: '👤', label: USER_LABELS[usersId] ?? `Usuário ${usersId}` };
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

// "YYYY-MM-DD HH:MM:SS" ordena como texto.
function byDate(a, b) {
  if (a.date === b.date) {
    return a.order - b.order;
  }
  return a.date < b.date ? -1 : 1;
}

export function buildTimeline(followups = [], solutions = []) {
  const items = [];
  let order = 0;
  for (const f of followups) {
    items.push({
      kind: 'note',
      date: f.date,
      order: order++,
      author: authorOf(f),
      text: stripMarkers(f.content),
      private: f.is_private === 1,
    });
  }
  for (const s of solutions) {
    items.push({
      kind: 'solution',
      date: s.date_creation,
      order: order++,
      author: authorOf(s),
      text: stripMarkers(s.content),
      status: s.status,
    });
    if (s.status !== 2 && s.date_approval) {
      items.push({
        kind: 'decision',
        date: s.date_approval,
        order: order++,
        author: { icon: '👤', label: USER_LABELS[s.users_id_approval] ?? 'Técnico' },
        text: `Solução ${solutionStatusLabel(s.status)}.`,
        status: s.status,
      });
    }
  }
  return items.sort(byDate);
}

export function pendingSolution(solutions = []) {
  return solutions.find((s) => s.status === 2) ?? null;
}
