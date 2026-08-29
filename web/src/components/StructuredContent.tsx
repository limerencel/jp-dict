/**
 * Yomitan structured-content 渲染器。
 *
 * 词典数据来自第三方，结构不可信：这里对标签、属性、样式全部做白名单/归一化，
 * 任何看不懂的东西降级为 <span>，绝不抛异常（外层还有 ErrorBoundary 兜底）。
 */
import { createElement, Fragment, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import type { SCElement, SCNode } from '@shared/types';
import { mediaUrl } from '../api';

export interface StructuredContentProps {
  content: SCNode;
  /** 用于拼接内嵌图片地址 */
  dictId: number;
  /** 点击 `?query=…` 形式的词典内部链接 */
  onInternalLookup?: (query: string) => void;
}

/** 允许直接映射到同名 HTML 标签的集合 */
const ALLOWED = new Set([
  'br', 'ruby', 'rt', 'rp',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'span', 'div', 'ol', 'ul', 'li',
  'details', 'summary',
]);

type AnyProps = Record<string, unknown>;
// createElement 的字符串重载对属性类型收得很紧，这里集中做一次受控转换
const h = createElement as unknown as (
  type: string,
  props: AnyProps | null,
  ...children: ReactNode[]
) => ReactElement;

function kebab(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
}

/** Yomitan 的 style 键已是 camelCase；只处理数组值与明显非法的值 */
function toStyle(style: SCElement['style']): CSSProperties | undefined {
  if (!style || typeof style !== 'object') return undefined;
  const out: Record<string, string | number> = {};
  for (const [key, raw] of Object.entries(style as Record<string, unknown>)) {
    if (!/^[a-zA-Z-]+$/.test(key)) continue;
    let value: string | number;
    if (Array.isArray(raw)) value = raw.filter((v) => typeof v === 'string' || typeof v === 'number').join(' ');
    else if (typeof raw === 'string' || typeof raw === 'number') value = raw;
    else continue;
    if (value === '' ) continue;
    out[key] = value;
  }
  return Object.keys(out).length ? (out as CSSProperties) : undefined;
}

/** data → data-sc-*，便于按词典自定义 CSS */
function dataAttrs(data: SCElement['data']): AnyProps {
  const out: AnyProps = {};
  if (!data || typeof data !== 'object') return out;
  for (const [key, raw] of Object.entries(data)) {
    if (raw == null) continue;
    out[`data-sc-${kebab(key)}`] = String(raw);
  }
  return out;
}

/** 从 `?query=xxx&wildcards=off` 里取出查询词 */
function internalQuery(href: string): string | null {
  if (typeof href !== 'string' || !href.startsWith('?')) return null;
  try {
    const params = new URLSearchParams(href.slice(1));
    const q = params.get('query');
    return q ? q : null;
  } catch {
    return null;
  }
}

function isElement(node: unknown): node is SCElement {
  return !!node && typeof node === 'object' && !Array.isArray(node) && typeof (node as SCElement).tag === 'string';
}

interface Ctx {
  dictId: number;
  onInternalLookup?: (query: string) => void;
}

function renderImage(el: SCElement, key: string, ctx: Ctx): ReactNode {
  const path = typeof el.path === 'string' ? el.path : '';
  if (!path) return null;
  const unit = el.sizeUnits === 'em' ? 'em' : 'px';
  const style: CSSProperties = { ...toStyle(el.style) };
  if (typeof el.width === 'number') style.width = `${el.width}${unit}`;
  if (typeof el.height === 'number') style.height = `${el.height}${unit}`;
  if (typeof el.imageRendering === 'string') style.imageRendering = el.imageRendering as CSSProperties['imageRendering'];
  if (el.background === false) style.background = 'transparent';

  const img = h('img', {
    key: `${key}-img`,
    src: mediaUrl(ctx.dictId, path),
    alt: typeof el.alt === 'string' ? el.alt : (typeof el.description === 'string' ? el.description : ''),
    title: typeof el.title === 'string' ? el.title : undefined,
    loading: 'lazy',
    decoding: 'async',
    style,
    ...dataAttrs(el.data),
  });

  if (el.collapsible === false) return img;
  if (el.collapsible || el.collapsed) {
    return h(
      'details',
      { key, open: el.collapsed === false },
      h('summary', { key: `${key}-s` }, (typeof el.title === 'string' && el.title) || '展开图片'),
      img,
    );
  }
  return img;
}

function renderAnchor(el: SCElement, key: string, ctx: Ctx, children: ReactNode[]): ReactNode {
  const href = typeof el.href === 'string' ? el.href : '';
  const query = internalQuery(href);
  const style = toStyle(el.style);

  if (query) {
    return h(
      'button',
      {
        key,
        type: 'button',
        className: 'sc-link',
        lang: el.lang,
        style,
        title: `查询「${query}」`,
        onClick: () => ctx.onInternalLookup?.(query),
        ...dataAttrs(el.data),
      },
      ...children,
    );
  }
  if (!/^https?:\/\//i.test(href)) {
    // 既不是内部查询也不是可信外链：退化成普通文本，避免 javascript: 之类的协议
    return h('span', { key, className: 'sc-link', lang: el.lang, style, ...dataAttrs(el.data) }, ...children);
  }
  return h(
    'a',
    { key, className: 'sc-link', href, target: '_blank', rel: 'noreferrer', lang: el.lang, style, ...dataAttrs(el.data) },
    ...children,
  );
}

function renderNode(node: SCNode, key: string, ctx: Ctx): ReactNode {
  if (node == null) return null;
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) {
    return (
      <Fragment key={key}>{node.map((child, i) => renderNode(child, `${key}.${i}`, ctx))}</Fragment>
    );
  }
  if (!isElement(node)) return null;

  const el = node;
  const tag = el.tag;

  if (tag === 'br') return h('br', { key });
  if (tag === 'img') return renderImage(el, key, ctx);

  const children =
    el.content === undefined ? [] : [renderNode(el.content, `${key}.c`, ctx)];

  if (tag === 'a') return renderAnchor(el, key, ctx, children);

  const props: AnyProps = {
    key,
    lang: el.lang,
    style: toStyle(el.style),
    ...dataAttrs(el.data),
  };
  if (typeof el.title === 'string' && el.title) props.title = el.title;

  if (tag === 'td' || tag === 'th') {
    if (typeof el.colSpan === 'number' && el.colSpan > 1) props.colSpan = el.colSpan;
    if (typeof el.rowSpan === 'number' && el.rowSpan > 1) props.rowSpan = el.rowSpan;
  }
  if (tag === 'details') props.open = el.collapsed === false || undefined;

  const htmlTag = ALLOWED.has(tag) ? tag : 'span';
  if (!ALLOWED.has(tag)) props['data-sc-unknown-tag'] = tag;

  const rendered = h(htmlTag, props, ...children);
  // 详情栏只有 ~440px，宽表格单独给一个横向滚动容器，避免撞破布局
  if (htmlTag === 'table') return h('div', { key: `${key}-w`, className: 'sc-table-wrap' }, rendered);
  return rendered;
}

export function StructuredContent({ content, dictId, onInternalLookup }: StructuredContentProps): JSX.Element {
  return <div className="sc-root">{renderNode(content, 'sc', { dictId, onInternalLookup })}</div>;
}
