import { describe, expect, it } from 'vitest';
import { htmlToText } from '../../../src/domain/html-to-text.js';

describe('htmlToText (G2, G3)', () => {
  it('remove <script>, <style> e <head> junto com o conteúdo', () => {
    const html = [
      '<head><title>Ignorar</title><style>body { display: none; }</style></head>',
      '<p>Texto visível</p>',
      '<script type="text/javascript">alert("xss")</script>',
      '<STYLE>.oculto { color: red }</STYLE>',
      '<p>Final</p>',
      '<script>sem fechar',
    ].join('');

    expect(htmlToText(html)).toBe('Texto visível\nFinal');
  });

  it('remove tags não fechadas de bloco quando o > ou a tag de fechamento falta', () => {
    expect(htmlToText('Antes<script src="x"')).toBe('Antes');
    expect(htmlToText('Antes<script>codigo</script')).toBe('Antes');
    expect(htmlToText('Texto <header>Topo</header> <scripting>ok</scripting>')).toBe(
      'Texto Topo ok',
    );
  });

  it('atributos de evento e javascript: somem com a tag', () => {
    const html =
      '<img src=x onerror=alert(1)><a href="javascript:evil()">clique</a> e <b>negrito</b>';
    expect(htmlToText(html)).toBe('clique e negrito');
  });

  it('parágrafos, <br> e itens de lista viram quebras de linha legíveis', () => {
    const html = [
      '<h1>Título</h1>',
      '<p>Primeiro   parágrafo<br/>segunda linha</p>',
      '<div><ul><li>Item 1</li><li>Item 2</li></ul></div>',
      '<table><tr><td>Celula</td></tr></table>',
    ].join('\n\n\n');

    expect(htmlToText(html)).toBe(
      'Título\n\nPrimeiro parágrafo\nsegunda linha\n\n- Item 1\n- Item 2\n\nCelula',
    );
  });

  it('entidades nomeadas e numéricas são decodificadas e &lt;script&gt; continua sendo só texto', () => {
    const html =
      '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;aspas&quot; &#39;ok&#39; &nbsp; &#65; &#x42; &desconhecida; &#0; &#x110000; &#xD800;</p>';
    expect(htmlToText(html)).toBe(
      '<script>alert(1)</script> & "aspas" \'ok\' A B &desconhecida; \uFFFD \uFFFD \uFFFD',
    );
  });

  it('comentários HTML, declarações e tags malformadas não vazam', () => {
    expect(htmlToText('<!DOCTYPE html><!-- segredo -->Oi <!-- sem fechar')).toBe('Oi');
    expect(htmlToText('<!DOCTYPE sem fechar')).toBe('');
    expect(htmlToText('Texto <<b>>forte<</b>> <div aberto')).toBe('Texto forte');
  });

  it('emoji e acentos são preservados (G3, U)', () => {
    const html = '<p>Ação de manutenção no 3º andar 🛠️ — técnica: São Paulo 👨‍👩‍👧</p>';
    expect(htmlToText(html)).toBe(
      'Ação de manutenção no 3º andar 🛠️ — técnica: São Paulo 👨‍👩‍👧',
    );
  });

  it('100 KB de HTML são convertidos em menos de 200 ms (G3, U)', () => {
    const chunk = '<p>Linha de teste com <b>formatação</b> e &amp; entidade</p>\n';
    const bigHtml = chunk.repeat(Math.ceil(102_400 / chunk.length));
    expect(bigHtml.length).toBeGreaterThanOrEqual(102_400);

    const start = performance.now();
    const out = htmlToText(bigHtml);
    const elapsedMs = performance.now() - start;

    expect(out.startsWith('Linha de teste com formatação e & entidade')).toBe(true);
    expect(elapsedMs).toBeLessThan(200);
  });

  it('caracteres de controle são removidos e \\r\\n vira \\n', () => {
    const html = 'Linha 1\u0000\u0007\r\nLinha 2\rLinha 3\u001F\tcom tab';
    expect(htmlToText(html)).toBe('Linha 1\nLinha 2\nLinha 3 com tab');
  });
});
