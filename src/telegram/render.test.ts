// Unit tests for the rendering helpers (src/telegram/render.ts): escaping,
// URLs as code entities that stay valid Telegram HTML and show their
// invisible characters, bidi isolation outside the entity, withLinks().
import { describe, expect, it } from 'vitest';
import { escapeHtml, telegramHtmlProblems } from '../i18n/html';
import { t } from '../i18n/index';
import { bidiIsolate, codeText, codeUrl, escape, FSI, PDI, safeText, withLinks } from './render';

const URL = 'https://www.instagram.com/reported.account/';

describe('escape', () => {
  it('is the catalog escaper: report data is text, never markup', () => {
    expect(escape).toBe(escapeHtml);
    expect(escape('<a href="https://x.test/">&</a>')).toBe('&lt;a href=&quot;https://x.test/&quot;&gt;&amp;&lt;/a&gt;');
  });
});

describe('codeUrl', () => {
  it('wraps a URL in a code entity, so it is copyable and never a link', () => {
    expect(codeUrl(URL)).toBe(`<code>${URL}</code>`);
    expect(telegramHtmlProblems(codeUrl(URL))).toEqual([]);
  });

  it('escapes a URL that carries markup, so the entity cannot be broken out of', () => {
    const hostile = 'https://x.test/</code><a href="https://evil.test/">tap</a><code>&';
    const rendered = codeUrl(hostile);
    expect(rendered).toBe(
      '<code>https://x.test/&lt;/code&gt;&lt;a href=&quot;https://evil.test/&quot;&gt;tap&lt;/a&gt;&lt;code&gt;&amp;</code>',
    );
    expect(telegramHtmlProblems(rendered)).toEqual([]);
    expect(rendered).not.toContain('<a ');
  });

  it('shows control and format characters as U+FFFD instead of letting them reorder or hide the text', () => {
    const spoofed = 'https://x.test/\u202Emoc.elgoog\u202C/\u200Bpath\n';
    expect(codeUrl(spoofed)).toBe('<code>https://x.test/\uFFFDmoc.elgoog\uFFFD/\uFFFDpath\uFFFD</code>');
  });
});

describe('bidiIsolate', () => {
  it('puts a run between FIRST STRONG ISOLATE and POP DIRECTIONAL ISOLATE', () => {
    expect(FSI).toBe('\u2068');
    expect(PDI).toBe('\u2069');
    expect(bidiIsolate('abc')).toBe('\u2068abc\u2069');
  });
});

describe('withLinks', () => {
  const text = t('en', 'press.thanks');

  it('puts each URL on its own line as code, after the text', () => {
    expect(withLinks('en', text, [URL, 'https://x.com/someone'])).toBe(
      `${text}\n<code>${URL}</code>\n<code>https://x.com/someone</code>`,
    );
  });

  it('isolates each URL line in Persian, outside the code entity, so a copied URL stays clean', () => {
    const rendered = withLinks('fa', t('fa', 'press.thanks'), [URL]);
    expect(rendered).toBe(`${t('fa', 'press.thanks')}\n\u2068<code>${URL}</code>\u2069`);
    const inside = /<code>([^<]*)<\/code>/.exec(rendered)?.[1];
    expect(inside).toBe(URL);
  });

  it('returns the text alone without URLs', () => {
    expect(withLinks('fa', text, [])).toBe(text);
  });

  it('yields valid Telegram HTML for hostile URLs too', () => {
    expect(telegramHtmlProblems(withLinks('fa', text, ['https://x.test/<b>&', URL]))).toEqual([]);
  });
});

describe('safeText and codeText', () => {
  it('escape free text, so it is text and never markup, and keep its line breaks', () => {
    expect(safeText('a <b>bold</b> & "quoted"\nnext line')).toBe('a &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;\nnext line');
    expect(codeText('see https://x.test/ <a href="https://evil.test/">')).toBe(
      '<code>see https://x.test/ &lt;a href=&quot;https://evil.test/&quot;&gt;</code>',
    );
    expect(telegramHtmlProblems(codeText('</code><b>&'))).toEqual([]);
  });

  it('show control characters and bidi controls as U+FFFD, and keep the joiners Persian needs', () => {
    expect(safeText('a\u202Eb\u2066c\u0007d\te')).toBe('a\uFFFDb\uFFFDc\uFFFDd\uFFFDe');
    expect(safeText('می\u200Cخواهم\u200D')).toBe('می\u200Cخواهم\u200D');
  });
});
