import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_UI_DIR, UI_FILES } from '../../src/ui.js';

const FORBIDDEN = /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval)\b|new Function\s*\(/;

test('nenhum arquivo da UI usa innerHTML, outerHTML, insertAdjacentHTML, document.write ou eval', () => {
  for (const name of Object.keys(UI_FILES)) {
    const lines = fs.readFileSync(path.join(DEFAULT_UI_DIR, name), 'utf8').split('\n');
    lines.forEach((line, idx) => {
      // Comentários podem citar a regra sem violá-la.
      const code = line.replace(/\/\/.*$/, '');
      assert.doesNotMatch(code, FORBIDDEN, `${name}:${idx + 1} usa API proibida: ${line.trim()}`);
    });
  }
});

test('index.html não tem script nem estilo inline (a CSP não permite unsafe-inline)', () => {
  const html = fs.readFileSync(path.join(DEFAULT_UI_DIR, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /<style\b|\sstyle=|\son[a-z]+=/i);
});

test('a UI não anuncia funcionalidade fora do escopo (conversa e aprovações do B → A)', () => {
  for (const name of Object.keys(UI_FILES)) {
    const text = fs.readFileSync(path.join(DEFAULT_UI_DIR, name), 'utf8');
    assert.doesNotMatch(text, /disponíve(l|is) quando a S\d/, `${name} ainda promete uma story cortada`);
  }
});
