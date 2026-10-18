import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOMAIN_DIR = resolve(__dirname, '../../../src/domain');

const IMPORT_SPECIFIER_PATTERN = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: 'node:fs', regex: /\bnode:fs\b|\bfs\b/ },
  { label: 'node:http', regex: /\bnode:https?\b|\bhttps?\b/ },
  { label: 'node:net', regex: /\bnode:net\b/ },
  { label: 'pg', regex: /\bpg\b/ },
  { label: 'fastify', regex: /\bfastify\b/ },
  { label: 'process.env', regex: /\bprocess\.env\b/ },
  { label: 'Date.now', regex: /\bDate\.now\s*\(/ },
  { label: 'fetch', regex: /\bfetch\s*\(/ },
];

describe('pureza do domínio (CONTRIBUTING.md, seção 18)', () => {
  it('o domínio não importa I/O nem lê ambiente ou relógio', () => {
    const files = readdirSync(DOMAIN_DIR).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = readFileSync(resolve(DOMAIN_DIR, file), 'utf8');

      for (const match of content.matchAll(IMPORT_SPECIFIER_PATTERN)) {
        const specifier = match[1]!;
        const isAllowed = specifier.startsWith('./') || specifier === 'node:crypto';
        expect(
          isAllowed,
          `Import proibido "${specifier}" encontrado em src/domain/${file}`,
        ).toBe(true);
      }

      for (const { label, regex } of FORBIDDEN_PATTERNS) {
        expect(
          regex.test(content),
          `Uso proibido de "${label}" encontrado em src/domain/${file}`,
        ).toBe(false);
      }
    }
  });
});
