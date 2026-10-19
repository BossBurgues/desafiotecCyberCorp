import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

// Lista fechada: nenhum caminho vem da URL, então não há path traversal possível.
export const UI_FILES = Object.freeze({
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'ui-core.js': 'text/javascript; charset=utf-8',
  'styles.css': 'text/css; charset=utf-8',
});

export const UI_SECURITY_HEADERS = Object.freeze({
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
});

// Rotas que ligam as seções de conversa (S1.4) e aprovações (S1.5) na UI.
const FEATURE_ROUTES = Object.freeze({
  followups: { method: 'GET', url: '/apirest.php/Ticket/:id/ITILFollowup' },
  solutions: { method: 'PUT', url: '/apirest.php/ITILSolution/:id' },
});

export function loadUiAssets(dir = DEFAULT_UI_DIR) {
  const assets = new Map();
  for (const [name, contentType] of Object.entries(UI_FILES)) {
    // Arquivo ausente lança aqui: o servidor não sobe com a UI incompleta.
    assets.set(name, { body: fs.readFileSync(path.join(dir, name)), contentType });
  }
  return assets;
}

function hasRoute(routes, { method, url }) {
  return routes.some((route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    return route.url === url && methods.includes(method);
  });
}

export function detectFeatures(routes) {
  return {
    followups: hasRoute(routes, FEATURE_ROUTES.followups),
    solutions: hasRoute(routes, FEATURE_ROUTES.solutions),
  };
}
