const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  ndash: '–',
  mdash: '—',
  hellip: '…',
};

function stripBlockElement(input: string, tagName: string): string {
  const lower = input.toLowerCase();
  const openToken = `<${tagName}`;
  const closeToken = `</${tagName}`;
  let result = '';
  let cursor = 0;

  while (cursor < input.length) {
    const start = lower.indexOf(openToken, cursor);
    if (start === -1) {
      result += input.slice(cursor);
      break;
    }
    const afterTagChar = lower[start + openToken.length];
    if (afterTagChar !== undefined && /[a-z0-9-]/.test(afterTagChar)) {
      result += input.slice(cursor, start + openToken.length);
      cursor = start + openToken.length;
      continue;
    }

    result += input.slice(cursor, start);
    const openEnd = lower.indexOf('>', start + openToken.length);
    if (openEnd === -1) {
      break;
    }
    const closeStart = lower.indexOf(closeToken, openEnd + 1);
    if (closeStart === -1) {
      break;
    }
    const closeEnd = lower.indexOf('>', closeStart + closeToken.length);
    if (closeEnd === -1) {
      break;
    }
    cursor = closeEnd + 1;
  }

  return result;
}

function stripCommentsAndDeclarations(input: string): string {
  let result = '';
  let cursor = 0;

  while (cursor < input.length) {
    const start = input.indexOf('<!', cursor);
    if (start === -1) {
      result += input.slice(cursor);
      break;
    }
    result += input.slice(cursor, start);
    if (input.startsWith('<!--', start)) {
      const endComment = input.indexOf('-->', start + 4);
      if (endComment === -1) {
        break;
      }
      cursor = endComment + 3;
    } else {
      const endDecl = input.indexOf('>', start + 2);
      if (endDecl === -1) {
        break;
      }
      cursor = endDecl + 1;
    }
  }

  return result;
}

function decodeCodePoint(codePoint: number): string {
  if (
    !Number.isInteger(codePoint) ||
    codePoint <= 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return '\uFFFD';
  }
  return String.fromCodePoint(codePoint);
}

function decodeEntities(input: string): string {
  return input.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g, (full, dec, hex, named) => {
    if (typeof dec === 'string') {
      return decodeCodePoint(Number.parseInt(dec, 10));
    }
    if (typeof hex === 'string') {
      return decodeCodePoint(Number.parseInt(hex, 16));
    }
    const replacement = NAMED_ENTITIES[(named as string).toLowerCase()];
    return replacement ?? full;
  });
}

export function htmlToText(html: string): string {
  let text = html.replace(/\r\n?/g, '\n');

  text = stripCommentsAndDeclarations(text);
  text = stripBlockElement(text, 'script');
  text = stripBlockElement(text, 'style');
  text = stripBlockElement(text, 'head');

  text = text.replace(/<\s*br\b[^>]*>/gi, '\n');
  text = text.replace(/<\s*li\b[^>]*>/gi, '- ');
  text = text.replace(/<\s*\/\s*(?:p|div|li|tr|h[1-6])\s*>/gi, '\n');

  // Remove todas as demais tags (inclusive tags malformadas no fim do texto)
  text = text.replace(/<\/?[a-zA-Z][^>\n]*(?:>|$)/g, '');
  text = text.replace(/[<>]/g, '');

  text = decodeEntities(text);

  // Remove caracteres de controle exceto \n (0x0a) e \t (0x09)
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');

  // Colapsa espaços horizontais por linha e limita no máximo 1 linha em branco seguida
  const lines = text.split('\n').map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim());
  const normalized = lines.join('\n').replace(/\n{3,}/g, '\n\n');

  return normalized.trim();
}
