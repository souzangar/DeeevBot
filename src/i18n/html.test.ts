// Unit tests for the Telegram HTML helpers: the escaping t() applies to its
// parameters, and the checker the catalog test runs (tested here on its own,
// so that a checker that accepted everything could not pass the catalogs
// vacuously).
import { describe, expect, it } from 'vitest';
import { escapeHtml, telegramHtmlProblems } from './html';

describe('escapeHtml', () => {
  it('escapes &, <, > and "', () => {
    expect(escapeHtml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;');
  });

  it('leaves everything else alone, Persian text included', () => {
    const text = "plain text, it's {fine} — مشکلی پیش آمد";
    expect(escapeHtml(text)).toBe(text);
  });

  it('escapes an entity-like text too, so it shows as typed', () => {
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });

  it('yields text the checker accepts', () => {
    expect(telegramHtmlProblems(escapeHtml('<b>x</b> & <a href="y">z</a> > "w"'))).toEqual([]);
  });
});

describe('telegramHtmlProblems', () => {
  it.each([
    ['plain text', 'Something went wrong. Please try again later.'],
    ['Persian text', 'مشکلی پیش آمد. لطفاً بعداً دوباره تلاش کنید.'],
    ['the four admitted tags', '<b>b</b> <i>i</i> <code>c</code> <a href="https://example.org/">a</a>'],
    ['nested tags', '<b>bold <i>and italic</i></b>'],
    ['the supported entities', '&lt; &gt; &amp; &quot; &#1601; &#x1F600;'],
    ['an escaped ampersand in a link', '<a href="https://example.org/?a=1&amp;b=2">a</a>'],
    ['a placeholder', 'Check <code>{variables}</code>'],
    ['an empty string', ''],
  ])('accepts %s', (_label, html) => {
    expect(telegramHtmlProblems(html)).toEqual([]);
  });

  it.each([
    ['an unescaped ampersand', 'salt & pepper'],
    ['an unescaped <', 'a < b'],
    ['an unescaped >', 'a > b'],
    ['an unsupported named entity', 'a&nbsp;b'],
    ['an unterminated entity', 'a &amp b'],
    ['an unclosed tag', '<b>bold'],
    ['a stray closing tag', 'bold</b>'],
    ['crossed tags', '<b><i>x</b></i>'],
    ['a tag the catalogs do not admit', '<u>underlined</u>'],
    ['an uppercase tag', '<B>bold</B>'],
    ['a link without href', '<a>x</a>'],
    ['a link with an empty href', '<a href="">x</a>'],
    ['a link with another attribute', '<a href="https://example.org/" target="x">x</a>'],
    ['an attribute on <b>', '<b class="x">x</b>'],
    ['an attribute on a closing tag', '<b>x</b class="x">'],
    ['a tag inside <code>', '<code><b>x</b></code>'],
    ['an unescaped ampersand in an attribute', '<a href="https://example.org/?a=1&b=2">x</a>'],
  ])('rejects %s', (_label, html) => {
    expect(telegramHtmlProblems(html)).not.toEqual([]);
  });

  it('says where each problem is', () => {
    expect(telegramHtmlProblems('ok & <b>x')).toEqual(['an unescaped & at 3', 'an unclosed <b>']);
  });
});
