/**
 * 把词典自带样式表限定到 `.mdx-dict-<id>` 容器内。
 *
 * 词典 CSS 里常见 `p { display: block }`、`body { ... }` 这种裸选择器，
 * 不作用域化会直接污染整个应用，所以每一条选择器都必须加前缀。
 */

/** 这些 at-rule 的块里还是选择器，需要递归处理 */
const NESTED_AT = new Set(['media', 'supports', 'document', 'layer', 'container', 'scope']);
/** 这些 at-rule 的块里只有声明或帧，原样保留 */
const VERBATIM_AT = new Set(['font-face', 'page', 'keyframes', 'counter-style', 'property', 'viewport', 'font-feature-values']);

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 把 url(xxx) 里的相对路径指到词典自己的媒体目录 */
function rewriteUrls(text: string, mediaBase: string): string {
  return text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote: string, target: string) => {
    const raw = target.trim();
    if (!raw || /^(data:|https?:|\/\/)/i.test(raw)) return match;
    const clean = raw.replace(/^file:\/\//i, '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    return `url("${mediaBase}${clean}")`;
  });
}

/** 按顶层逗号切分选择器组，括号/方括号/引号内的逗号不算 */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (quote) {
      if (ch === quote && list[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  out.push(list.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** html/body/:root 这类根选择器要替换成容器本身，而不是变成它的后代 */
const ROOT_SELECTOR = /^(?:html|body|:root)\b/i;

function scopeSelector(selector: string, scope: string): string {
  const sel = selector.trim();
  if (!sel) return '';
  if (sel.startsWith(scope)) return sel;
  if (sel === '*') return `${scope} *`;
  if (ROOT_SELECTOR.test(sel)) {
    const rest = sel.replace(ROOT_SELECTOR, '');
    // body.foo → .mdx-dict-1.foo；body div → .mdx-dict-1 div
    return rest ? `${scope}${rest}` : scope;
  }
  return `${scope} ${sel}`;
}

function scopeSelectorList(list: string, scope: string): string {
  const scoped = splitSelectors(list)
    .map((s) => scopeSelector(s, scope))
    .filter(Boolean);
  return scoped.join(', ');
}

/** 从 open（指向 '{'）开始找配对的 '}'，返回其下标；找不到返回 -1 */
function matchBrace(css: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === quote && css[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function transformRules(css: string, scope: string, mediaBase: string, depth: number): string {
  const out: string[] = [];
  let i = 0;
  while (i < css.length) {
    // 找下一条规则的起点
    while (i < css.length && /\s/.test(css[i])) i++;
    if (i >= css.length) break;

    const brace = css.indexOf('{', i);
    const semi = css.indexOf(';', i);
    // 无块的 at-rule（@charset / @import / @namespace）直接丢弃
    if (semi >= 0 && (brace < 0 || semi < brace)) {
      const stmt = css.slice(i, semi).trim();
      if (stmt && !stmt.startsWith('@')) out.push(`${stmt};`);
      i = semi + 1;
      continue;
    }
    if (brace < 0) break;

    const prelude = css.slice(i, brace).trim();
    const close = matchBrace(css, brace);
    const end = close < 0 ? css.length : close;
    const inner = css.slice(brace + 1, end);
    i = close < 0 ? css.length : close + 1;
    if (!prelude) continue;

    if (prelude.startsWith('@')) {
      const at = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? '';
      if (NESTED_AT.has(at) && depth < 4) {
        const body = transformRules(inner, scope, mediaBase, depth + 1);
        if (body.trim()) out.push(`${prelude} {\n${body}}\n`);
      } else if (VERBATIM_AT.has(at)) {
        out.push(`${prelude} {${rewriteUrls(inner, mediaBase)}}\n`);
      }
      // 其余未知 at-rule 丢弃，避免放进无法预期的东西
      continue;
    }

    const selectors = scopeSelectorList(prelude, scope);
    if (!selectors) continue;
    out.push(`${selectors} {${rewriteUrls(inner, mediaBase)}}\n`);
  }
  return out.join('');
}

/**
 * @param scope 容器选择器，如 `.mdx-dict-7`
 * @param mediaBase 媒体前缀，如 `/api/media/7/`
 */
export function scopeCss(css: string, scope: string, mediaBase: string): string {
  if (!css.trim()) return '';
  return transformRules(stripComments(css).replace(/^\uFEFF/, ''), scope, mediaBase, 0).trim();
}
