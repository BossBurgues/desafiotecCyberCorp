// Cadastro de usuário pela tela de login: validação pura (o servidor grava, a UI só mostra as frases).

export const SELF_SERVICE_PROFILES = Object.freeze(['tecnico', 'estagiario']);
const LOGIN_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

function invalid(message) {
  const err = new Error(message);
  err.glpiCode = 'ERROR_INVALID_INPUT';
  err.statusCode = 400;
  return err;
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');

function forbidden(message) {
  const err = new Error(message);
  err.glpiCode = 'ERROR_RIGHT_MISSING';
  err.statusCode = 403;
  return err;
}

/**
 * Valida o `input` do POST /register e devolve os campos normalizados (login em minúsculas).
 * O cadastro pela tela cria **Estagiário**. Técnico só com `allowTecnico` (A_SELF_REGISTER_TECNICO=true, para uso
 * local): na URL pública, qualquer visitante viraria Técnico e poderia editar, fechar e excluir chamados.
 */
export function validateRegistration(input, { allowTecnico = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('O corpo deve ter "input".');
  }
  for (const key of Object.keys(input)) {
    if (!['name', 'firstname', 'realname', 'password', 'profile'].includes(key)) {
      throw invalid(`Campo não permitido no input: ${key}.`);
    }
  }
  const login = text(input.name).toLowerCase();
  if (!LOGIN_PATTERN.test(login)) {
    throw invalid('O login deve ter de 3 a 32 caracteres: letras minúsculas, números, ponto, hífen ou sublinhado.');
  }
  const firstname = text(input.firstname);
  const realname = text(input.realname);
  if (firstname.length < 1 || firstname.length > 60) {
    throw invalid('Informe o nome (até 60 caracteres).');
  }
  if (realname.length > 60) {
    throw invalid('O sobrenome pode ter até 60 caracteres.');
  }
  if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128) {
    throw invalid('A senha deve ter de 8 a 128 caracteres.');
  }
  const profile = input.profile ?? 'estagiario';
  if (!SELF_SERVICE_PROFILES.includes(profile)) {
    throw invalid('Escolha o nível: Técnico ou Estagiário.');
  }
  if (profile === 'tecnico' && !allowTecnico) {
    throw forbidden('O cadastro pela tela cria contas de Estagiário. Para atender chamados, peça a um Técnico.');
  }
  return { login, firstname, realname, password: input.password, profile };
}
