/**
 * 第三方词典 HTML 的消毒与链接改写。导入时做一次，查询期直接吐结果。
 *
 * 只做标签级扫描，不建 DOM：词典 HTML 结构简单，且我们采用白名单属性 +
 * 黑名单标签，即使解析有偏差也不会放出可执行内容。
 */

/** 连同内容一起丢弃 */
const DROP_SUBTREE = new Set(['script', 'style', 'iframe', 'object', 'embed', 'applet', 'noscript', 'frameset', 'title']);
/** 只丢标签本身，保留子内容 */
const DROP_TAG_ONLY = new Set(['html', 'head', 'body', 'link', 'meta', 'base', 'form', 'input', 'button', 'select', 'textarea']);

const ALLOWED_ATTRS = new Set([
  'class', 'href', 'src', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan',
  'align', 'valign', 'style', 'lang', 'dir', 'border', 'cellpadding', 'cellspacing',
  'span', 'start', 'color', 'size', 'face', 'nowrap',
]);

/** 这些扩展名说明 href 指向资源文件而不是词头 */
const RESOURCE_EXT = /\.(css|js|html?|xml|json)(\?.*)?$/i;
const DANGEROUS_SCHEME = /^\s*(javascript|vbscript|data|file)\s*:/i;
const SAFE_SCHEME = /^\s*(https?:|mailto:|tel:)/i;

export interface SanitizeOptions {
  /** 媒体前缀，形如 `/api/media/7/` */
  mediaBase: string;
}

interface Attr {
  name: string;
  value: string | null;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** MDict 约定：裸 href 或 entry:// 都是跳转到另一个词头 */
function toQueryLink(target: string): string | null {
  let word = target.replace(/^entry:\/\//i, '').replace(/^\/+/, '');
  const hash = word.indexOf('#');
  if (hash >= 0) word = word.slice(0, hash);
  try {
    word = decodeURIComponent(word);
  } catch {
    /* 保留原样 */
  }
  word = word.trim();
  return word ? `?query=${encodeURIComponent(word)}` : null;
}

function normalizeMediaPath(value: string): string {
  return value
    .replace(/^file:\/\//i, '')
    .replace(/^sound:\/\//i, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

function rewriteHref(value: string, opts: SanitizeOptions): string | null {
  const raw = value.trim();
  if (!raw) return null;
  if (DANGEROUS_SCHEME.test(raw)) return null;
  if (SAFE_SCHEME.test(raw)) return raw;
  if (raw.startsWith('#')) return null; // 词条内锚点在我们的渲染容器里没有意义
  if (/^sound:\/\//i.test(raw)) return opts.mediaBase + normalizeMediaPath(raw);
  if (/^entry:\/\//i.test(raw)) return toQueryLink(raw);
  if (RESOURCE_EXT.test(raw)) return null;
  return toQueryLink(raw);
}

function rewriteSrc(value: string, opts: SanitizeOptions): string | null {
  const raw = value.trim();
  if (!raw) return null;
  if (/^data:image\//i.test(raw)) return raw;
  if (DANGEROUS_SCHEME.test(raw)) return null;
  if (SAFE_SCHEME.test(raw)) return raw;
  return opts.mediaBase + normalizeMediaPath(raw);
}

/** 解析开始标签内部的属性列表 */
function parseAttrs(text: string): Attr[] {
  const attrs: Attr[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /[\s/]/.test(text[i])) i++;
    const start = i;
    while (i < text.length && !/[\s=/>]/.test(text[i])) i++;
    if (i === start) {
      i++;
      continue;
    }
    const name = text.slice(start, i);
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '=') {
      attrs.push({ name, value: null });
      continue;
    }
    i++;
    while (i < text.length && /\s/.test(text[i])) i++;
    const quote = text[i];
    if (quote === '"' || quote === "'") {
      i++;
      const end = text.indexOf(quote, i);
      const stop = end < 0 ? text.length : end;
      attrs.push({ name, value: text.slice(i, stop) });
      i = stop + 1;
    } else {
      const vs = i;
      while (i < text.length && !/[\s>]/.test(text[i])) i++;
      attrs.push({ name, value: text.slice(vs, i) });
    }
  }
  return attrs;
}

export function sanitizeEntryHtml(html: string, opts: SanitizeOptions): string {
  const out: string[] = [];
  /** 需要连同内容丢弃时，记住等待哪个结束标签 */
  let skipUntil: string | null = null;
  let skipDepth = 0;
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      if (!skipUntil) out.push(html.slice(i));
      break;
    }
    if (!skipUntil && lt > i) out.push(html.slice(i, lt));

    // 注释与 CDATA 整段丢弃
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }

    // 找标签结束，跳过引号内的 '>'
    let j = lt + 1;
    let quote = '';
    while (j < html.length) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j++;
    }
    if (j >= html.length) {
      // 没有闭合的 '<'，当作文本
      if (!skipUntil) out.push(html.slice(lt));
      break;
    }

    const inner = html.slice(lt + 1, j);
    i = j + 1;
    const closing = inner.startsWith('/');
    const body = closing ? inner.slice(1) : inner;
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(body);
    if (!nameMatch) continue;
    const tag = nameMatch[0].toLowerCase();

    if (skipUntil) {
      if (tag === skipUntil) {
        if (closing) {
          skipDepth--;
          if (skipDepth <= 0) skipUntil = null;
        } else if (!inner.endsWith('/')) {
          skipDepth++;
        }
      }
      continue;
    }

    if (DROP_SUBTREE.has(tag)) {
      if (!closing && !inner.endsWith('/')) {
        skipUntil = tag;
        skipDepth = 1;
      }
      continue;
    }
    if (DROP_TAG_ONLY.has(tag)) continue;

    if (closing) {
      out.push(`</${tag}>`);
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const attrs = parseAttrs(body.slice(nameMatch[0].length));
    const kept: string[] = [];
    for (const attr of attrs) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || !ALLOWED_ATTRS.has(name)) continue;
      if (attr.value === null) {
        kept.push(name);
        continue;
      }
      let value: string | null = attr.value;
      if (name === 'href') value = rewriteHref(value, opts);
      else if (name === 'src') value = rewriteSrc(value, opts);
      else if (name === 'style' && DANGEROUS_SCHEME.test(value)) value = null;
      if (value === null) continue;
      kept.push(`${name}="${escapeAttr(value)}"`);
    }
    out.push(`<${tag}${kept.length ? ' ' + kept.join(' ') : ''}${selfClosing ? '/' : ''}>`);
  }

  return out.join('').trim();
}
