/**
 * Yomitan 释义（含 structured-content）→ 纯文本。
 * 前后端共用：服务端用来生成 hover 的精简释义，前端用来做搜索/复制。
 */
import type { GlossaryNode, SCElement, SCNode } from './types.ts';

/** structured-content 中天然应该换行的块级标签 */
const BLOCK_TAGS = new Set(['div', 'p', 'ul', 'ol', 'li', 'table', 'tr', 'th', 'td', 'details', 'summary', 'br']);

/** 这些标签的内容对纯文本无意义（多为注音、图片说明） */
const SKIP_TAGS = new Set(['rt', 'rp', 'img']);

function scToText(node: SCNode, out: string[]): void {
  if (node == null) return;
  if (typeof node === 'string') {
    out.push(node);
    return;
  }
  if (typeof node === 'number') {
    out.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) scToText(child, out);
    return;
  }
  const el = node as SCElement;
  if (SKIP_TAGS.has(el.tag)) return;
  if (el.tag === 'br') {
    out.push('\n');
    return;
  }
  const block = BLOCK_TAGS.has(el.tag);
  if (block) out.push('\n');
  if (el.content !== undefined) scToText(el.content, out);
  if (block) out.push('\n');
}

/** MDict 词典的 HTML → 纯文本（块级标签转换行，其余标签直接去掉） */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 单条释义节点转文本 */
export function glossaryNodeToText(node: GlossaryNode): string {
  if (typeof node === 'string') return node;
  if (node && typeof node === 'object') {
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'image') return node.description || node.title || '';
    if (node.type === 'html') return htmlToText(node.html ?? '');
    if (node.type === 'structured-content') {
      const out: string[] = [];
      scToText(node.content, out);
      return out.join('');
    }
  }
  return '';
}

function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/ *\n+ */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * 把整条词条的释义扁平化为一行文本。
 * @param maxLen 截断长度，0 表示不截断
 */
export function glossaryToText(glossary: GlossaryNode[], maxLen = 0): string {
  const parts = glossary.map(glossaryNodeToText).map(normalizeWhitespace).filter(Boolean);
  let text = parts.join('；').replace(/\n/g, ' ');
  if (maxLen > 0 && text.length > maxLen) text = text.slice(0, maxLen - 1) + '…';
  return text;
}

/** 保留换行的多行版本，用于详情面板的降级展示 */
export function glossaryToLines(glossary: GlossaryNode[]): string[] {
  const lines: string[] = [];
  for (const node of glossary) {
    const text = normalizeWhitespace(glossaryNodeToText(node));
    if (text) lines.push(...text.split('\n'));
  }
  return lines;
}
