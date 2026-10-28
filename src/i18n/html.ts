// Telegram HTML (parse_mode HTML) for the i18n catalogs: escaping the values
// t() substitutes, and the checker that src/i18n/catalog.test.ts runs over
// every catalog string. The rules are the Bot API's: a <, > or & that is not
// part of a tag or an entity must be written as an entity, and the supported
// named entities are &lt;, &gt;, &amp; and &quot; (numeric ones are all
// supported). The checker is stricter than Telegram on purpose: it admits
// only the tags the catalogs use, <b>, <i>, <code> and <a href="...">, and no
// tag inside <code>.

const ENTITY_FOR: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

/** Escapes text for Telegram HTML, inside an element or an attribute value. */
export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"]/g, (char) => ENTITY_FOR[char] ?? char);

/** The tags the catalogs may use, with the attributes each one requires. */
const TAG_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  b: [],
  i: [],
  code: [],
  a: ['href'],
};

const ENTITY = /^&(?:lt|gt|amp|quot|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});/;
const TAG = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[A-Za-z][A-Za-z0-9-]*="[^"<>]*")*)\s*>/;
const ATTRIBUTE = /([A-Za-z][A-Za-z0-9-]*)="([^"<>]*)"/g;

/** The ampersands in an attribute value or a text run that start no entity. */
const bareAmpersands = (text: string, offset: number): string[] => {
  const problems: string[] = [];
  for (let at = text.indexOf('&'); at !== -1; at = text.indexOf('&', at + 1)) {
    if (!ENTITY.test(text.slice(at))) problems.push(`an unescaped & at ${offset + at}`);
  }
  return problems;
};

/**
 * Lists what keeps `html` from parsing as Telegram HTML under the catalogs'
 * rules: an unescaped <, > or &, a tag outside the admitted set or with the
 * wrong attributes, a tag inside <code>, and unbalanced or crossed tags. An
 * empty list means the string is valid.
 */
export function telegramHtmlProblems(html: string): string[] {
  const problems: string[] = [];
  const open: string[] = [];
  let at = 0;
  while (at < html.length) {
    const char = html[at];
    if (char === '>') {
      problems.push(`an unescaped > at ${at}`);
      at += 1;
    } else if (char === '<') {
      const tag = TAG.exec(html.slice(at));
      if (tag === null) {
        problems.push(`an unescaped < at ${at}`);
        at += 1;
        continue;
      }
      const [whole, slash = '', name = '', attributeText = ''] = tag;
      const closing = slash === '/';
      const required = Object.hasOwn(TAG_ATTRIBUTES, name) ? TAG_ATTRIBUTES[name] : undefined;
      if (required === undefined) {
        problems.push(`a <${slash}${name}> tag, which the catalogs do not admit, at ${at}`);
      } else if (closing) {
        if (attributeText.trim() !== '') problems.push(`attributes on </${name}> at ${at}`);
        if (open.at(-1) === name) open.pop();
        else problems.push(`a </${name}> that closes no open <${name}> at ${at}`);
      } else {
        if (open.includes('code')) problems.push(`a <${name}> inside <code> at ${at}`);
        const attributes = [...attributeText.matchAll(ATTRIBUTE)];
        const names = attributes.map((attribute) => attribute[1] ?? '');
        if (names.join(' ') !== required.join(' ')) {
          problems.push(`<${name}> needs exactly the attributes [${required.join(', ')}] at ${at}`);
        }
        for (const attribute of attributes) {
          const value = attribute[2] ?? '';
          if (value === '') problems.push(`an empty ${attribute[1] ?? ''} on <${name}> at ${at}`);
          problems.push(...bareAmpersands(value, at));
        }
        open.push(name);
      }
      at += whole.length;
    } else {
      const next = html.slice(at).search(/[<>]/);
      const end = next === -1 ? html.length : at + next;
      problems.push(...bareAmpersands(html.slice(at, end), at));
      at = end;
    }
  }
  for (const name of open.reverse()) problems.push(`an unclosed <${name}>`);
  return problems;
}
