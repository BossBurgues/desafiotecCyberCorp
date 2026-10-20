// Catálogos do GLPI que o chamado referencia por ID: categorias (ITILCategory), locais (Location) e usuários (User).
// No GLPI eles são cadastros administrativos; aqui são fixos, porque o desafio não pede a tela de cadastro.
// O sync lê estas rotas para converter os IDs em texto no formato do B (docs/field-mapping.md).

export const CATEGORIES = Object.freeze([
  { id: 1, name: 'Hardware', completename: 'Hardware' },
  { id: 2, name: 'Impressão', completename: 'Hardware > Impressão' },
  { id: 3, name: 'Rede', completename: 'Rede' },
  { id: 4, name: 'Acesso e senhas', completename: 'Acesso e senhas' },
  { id: 5, name: 'Software', completename: 'Software' },
]);

// Coordenadas fictícias (São Paulo), só para mostrar a conversão de localização com e sem coordenadas (G5).
export const LOCATIONS = Object.freeze([
  { id: 1, name: 'Matriz · 3º andar', completename: 'Matriz > 3º andar', latitude: -23.5614, longitude: -46.6559 },
  { id: 2, name: 'Matriz · Recepção', completename: 'Matriz > Recepção', latitude: -23.5612, longitude: -46.6561 },
  { id: 3, name: 'Filial Campinas', completename: 'Filial Campinas', latitude: -22.9056, longitude: -47.0608 },
  { id: 4, name: 'Home office', completename: 'Home office', latitude: null, longitude: null },
]);

// Nome de exibição dos usuários semeados; quem se cadastra pela tela tem o nome no banco. Senha e token nunca saem.
const DISPLAY = Object.freeze({
  tecnico: { firstname: 'Ana', realname: 'Souza' },
  estagiario: { firstname: 'Bruno', realname: 'Lima' },
  'sync-bot': { firstname: '', realname: 'Sincronizador' },
});

export function publicUser(row) {
  const display = DISPLAY[row.login] ?? { firstname: '', realname: row.login };
  return {
    id: row.id,
    name: row.login,
    firstname: row.firstname ?? display.firstname,
    realname: row.realname ?? display.realname,
    profile: row.profile,
  };
}

export function findById(list, id) {
  return list.find((item) => item.id === id) ?? null;
}
