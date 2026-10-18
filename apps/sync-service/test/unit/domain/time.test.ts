import { describe, expect, it } from 'vitest';
import { MappingError } from '../../../src/domain/errors.js';
import {
  glpiLocalToUtc,
  isValidTimeZone,
  pollLowerBoundLocal,
  utcToGlpiLocal,
} from '../../../src/domain/time.js';

describe('conversão de fuso e horário de verão (ADR-005, B11)', () => {
  it('date_mod de São Paulo vira UTC +3h (exemplo dos contratos)', () => {
    expect(glpiLocalToUtc('2026-10-18 14:03:22', 'America/Sao_Paulo')).toBe(
      '2026-10-18T17:03:22Z',
    );
  });

  it('hora repetida na volta do horário de verão usa a primeira ocorrência', () => {
    // America/New_York: em 2026-11-01 às 02:00 EDT (-04) volta para 01:00 EST (-05).
    // 01:30 ocorre duas vezes: 05:30Z (1ª, EDT) e 06:30Z (2ª, EST).
    expect(glpiLocalToUtc('2026-11-01 01:30:00', 'America/New_York')).toBe(
      '2026-11-01T05:30:00Z',
    );

    // Histórico America/Sao_Paulo: fim do horário de verão em 2019-02-16 à meia-noite (-02 -> -03).
    // 23:30 ocorre duas vezes: 2019-02-17T01:30:00Z (1ª, -02) e 2019-02-17T02:30:00Z (2ª, -03).
    expect(glpiLocalToUtc('2019-02-16 23:30:00', 'America/Sao_Paulo')).toBe(
      '2019-02-17T01:30:00Z',
    );
  });

  it('hora logo após o fim do horário de verão usa o novo offset padrão', () => {
    // 02:30 em 2026-11-01 já é inequivocamente EST (-05 -> 07:30Z), mas nominalUtcMs - 6h ainda estava em EDT (-04)
    expect(glpiLocalToUtc('2026-11-01 02:30:00', 'America/New_York')).toBe(
      '2026-11-01T07:30:00Z',
    );
  });

  it('hora inexistente na ida do horário de verão avança o buraco', () => {
    // America/New_York: em 2026-03-08 às 02:00 EST (-05) pula para 03:00 EDT (-04).
    // 02:30 não existe -> avança 1h para 03:30 EDT = 07:30:00Z.
    expect(glpiLocalToUtc('2026-03-08 02:30:00', 'America/New_York')).toBe(
      '2026-03-08T07:30:00Z',
    );

    // Histórico America/Sao_Paulo: início do horário de verão em 2018-11-04 à 00:00 (-03 -> -02).
    // 00:30 não existe -> avança 1h para 01:30 (-02) = 03:30:00Z.
    expect(glpiLocalToUtc('2018-11-04 00:30:00', 'America/Sao_Paulo')).toBe(
      '2018-11-04T03:30:00Z',
    );
  });

  it('virada de ano e 29 de fevereiro convertem certo', () => {
    expect(glpiLocalToUtc('2026-12-31 22:30:00', 'America/Sao_Paulo')).toBe(
      '2027-01-01T01:30:00Z',
    );
    expect(glpiLocalToUtc('2024-02-29 12:00:00', 'America/Sao_Paulo')).toBe(
      '2024-02-29T15:00:00Z',
    );
  });

  it('utcToGlpiLocal é a inversa fora das horas ambíguas', () => {
    const instants = [
      '2026-01-15T00:00:00Z',
      '2026-06-20T12:34:56Z',
      new Date('2026-10-18T17:03:22Z'),
      Date.UTC(2026, 11, 31, 23, 59, 59),
    ];
    for (const instant of instants) {
      const local = utcToGlpiLocal(instant, 'America/New_York');
      const backToUtc = glpiLocalToUtc(local, 'America/New_York');
      const expectedIso = `${new Date(instant).toISOString().slice(0, 19)}Z`;
      expect(backToUtc).toBe(expectedIso);
    }
  });

  it('formato inválido lança MappingError e fuso inválido lança RangeError', () => {
    expect(() => glpiLocalToUtc('2026-10-18T14:03:22Z', 'America/Sao_Paulo')).toThrow(
      MappingError,
    );
    expect(() => glpiLocalToUtc('2026-10-18 25:00:00', 'America/Sao_Paulo')).toThrow(
      MappingError,
    );
    expect(() => glpiLocalToUtc('2026-02-29 12:00:00', 'America/Sao_Paulo')).toThrow(
      MappingError,
    );
    expect(() => utcToGlpiLocal('data-invalida', 'America/Sao_Paulo')).toThrow(
      MappingError,
    );
    expect(() => glpiLocalToUtc('2026-10-18 14:03:22', 'Fuso/Inexistente')).toThrow(
      RangeError,
    );
    expect(isValidTimeZone('America/Sao_Paulo')).toBe(true);
    expect(isValidTimeZone('Fuso/Inexistente')).toBe(false);
    expect(isValidTimeZone('   ')).toBe(false);
  });

  describe('pollLowerBoundLocal (B11, parte U)', () => {
    it('na volta do horário de verão o limite do poll cobre a hora repetida', () => {
      // Checkpoint 05:58Z (01:58 EDT), sobreposição de 2 min -> fromUtc = 05:56Z (01:56 EDT).
      // Agora = 06:30Z (01:30 EST).
      // Um chamado alterado às 06:10Z (01:10 EST) tem date_mod = "2026-11-01 01:10:00".
      // Se usássemos o relógio de fromUtc no offset EDT ("2026-11-01 01:56:00"), "01:10:00" < "01:56:00" seria pulado!
      const bound = pollLowerBoundLocal(
        '2026-11-01T05:56:00Z',
        '2026-11-01T06:30:00Z',
        'America/New_York',
      );
      expect(bound).toBe('2026-11-01 00:56:00');
      expect('2026-11-01 01:10:00' >= bound).toBe(true);
    });

    it('sem virada de offset o limite é só o relógio local de from', () => {
      const bound = pollLowerBoundLocal(
        '2026-10-18T17:01:22Z',
        '2026-10-18T17:05:00Z',
        'America/Sao_Paulo',
      );
      expect(bound).toBe('2026-10-18 14:01:22');
    });

    it('intervalo de vários dias atravessando a virada usa o menor offset', () => {
      // Intervalo de 4 dias em que o início e o fim teriam offset maior ou intermediário,
      // mas a amostra diária encontra um offset menor (ex. atravessando o fim do DST em NY de 30/10 a 03/11,
      // ou de verão para inverno e de volta à primavera num intervalo longo).
      const boundAcrossDstFall = pollLowerBoundLocal(
        '2026-10-30T12:00:00Z',
        '2026-11-03T12:00:00Z',
        'America/New_York',
      );
      // 12:00Z no menor offset (-05 EST) = 07:00:00
      expect(boundAcrossDstFall).toBe('2026-10-30 07:00:00');

      // E quando o início e o fim estão no horário de verão (-04 EDT), mas o meio passa pelo inverno (-05 EST):
      const boundSummerToSummer = pollLowerBoundLocal(
        '2026-10-31T12:00:00Z',
        '2027-03-10T12:00:00Z',
        'America/New_York',
      );
      expect(boundSummerToSummer).toBe('2026-10-31 07:00:00');
    });

    it('rejeita toUtc anterior a fromUtc com MappingError', () => {
      expect(() =>
        pollLowerBoundLocal(
          '2026-10-18T18:00:00Z',
          '2026-10-18T17:00:00Z',
          'America/Sao_Paulo',
        ),
      ).toThrow(MappingError);
    });
  });
});
