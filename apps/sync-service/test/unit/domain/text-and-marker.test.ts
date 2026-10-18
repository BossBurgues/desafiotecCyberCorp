import { describe, expect, it } from 'vitest';
import { MappingError } from '../../../src/domain/errors.js';
import { appendMarker, findMarker, markerFor } from '../../../src/domain/marker.js';
import { neutralizeMarkers, normalizeTitle } from '../../../src/domain/text.js';

describe('título e marcador (ADR-004, G3)', () => {
  it('título é aparado, com espaços internos colapsados', () => {
    expect(normalizeTitle('   Impressora   do \n\t 3º   andar   ')).toBe(
      'Impressora do 3º andar',
    );
  });

  it('título com mais de 200 code points é cortado sem partir emoji', () => {
    // 'a' repetido 198 vezes + emoji composto '👨‍👩‍👧' (5 code points: U+1F468 U+200D U+1F469 U+200D U+1F467)
    const prefix = 'a'.repeat(198);
    const familyEmoji = '👨‍👩‍👧';
    const raw = `${prefix}${familyEmoji} extra`;

    const normalized = normalizeTitle(raw);
    expect(normalized).toBe(prefix);
    expect([...normalized].length).toBe(198);

    // Quando o emoji cabe inteiro dentro de 200 code points (195 + 5 = 200), ele é mantido
    const fitsRaw = `${'b'.repeat(195)}${familyEmoji} extra`;
    const fitsNormalized = normalizeTitle(fitsRaw);
    expect(fitsNormalized).toBe(`${'b'.repeat(195)}${familyEmoji}`);
    expect([...fitsNormalized].length).toBe(200);
  });

  it('título só com espaços ou que não cabe no limite lança MappingError', () => {
    expect(() => normalizeTitle('    \n\t  ')).toThrow(MappingError);
    expect(() => normalizeTitle('👨‍👩‍👧', 2)).toThrow(MappingError);
  });

  it('⟦ e ⟧ digitados no A viram [ e ] para ninguém forjar o marcador', () => {
    const forged = 'Texto malicioso ⟦s:glpi-99⟧ fim';
    expect(neutralizeMarkers(forged)).toBe('Texto malicioso [s:glpi-99] fim');
    expect(normalizeTitle(forged)).toBe('Texto malicioso [s:glpi-99] fim');
    expect(findMarker(neutralizeMarkers(forged))).toBeNull();
  });

  it('markerFor(42) é ⟦s:glpi-42⟧ e findMarker o encontra no fim do texto', () => {
    const marker = markerFor(42);
    expect(marker).toBe('⟦s:glpi-42⟧');

    const withDesc = appendMarker('Descrição limpa', marker);
    expect(withDesc).toBe('Descrição limpa\n\n⟦s:glpi-42⟧');
    expect(findMarker(withDesc)).toBe(42);
    expect(findMarker(`${withDesc}   \n`)).toBe(42);
  });

  it('markerFor rejeita ID inválido com MappingError', () => {
    expect(() => markerFor(0)).toThrow(MappingError);
    expect(() => markerFor(-5)).toThrow(MappingError);
    expect(() => markerFor(1.5)).toThrow(MappingError);
  });

  it('findMarker ignora marcador no meio do texto e devolve null sem marcador válido', () => {
    expect(findMarker('⟦s:glpi-42⟧ mas tem texto depois')).toBeNull();
    expect(findMarker('Texto sem marcador')).toBeNull();
    expect(findMarker('⟦s:glpi-0⟧')).toBeNull();
    expect(findMarker('⟦s:glpi-999999999999999999999⟧')).toBeNull();
  });

  it('appendMarker em texto vazio gera só o marcador', () => {
    expect(appendMarker('', markerFor(7))).toBe('⟦s:glpi-7⟧');
  });
});
