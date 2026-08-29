/**
 * 词典释义展示：词典分组 → 词条 → 释义。
 *
 * 释义有三条渲染路径：
 *   1. 纯文本 + 命中研究社排版约定  → glossFormat 解析成 AST 后按辞典排版渲染
 *   2. structured-content            → StructuredContent（明鏡・大辞林等）
 *   3. 其余纯文本                    → pre-wrap 段落（安全网，至少换行是对的）
 */
import { Fragment, useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import type { DictEntry, GlossaryNode, TagInfo } from '@shared/types';
import { glossaryNodeToText, glossaryToLines } from '@shared/glossary';
import { mediaUrl } from '../api';
import {
  blocksToPlainText,
  countExamples,
  looksStructured,
  parseGlossText,
  parseInline,
  type GlossBlock,
  type HeadwordBlock,
  type Inline,
  type SenseBlock,
} from '../lib/glossFormat';
import { ErrorBoundary } from './ErrorBoundary';
import { StructuredContent } from './StructuredContent';
import { IconCheck, IconCopy, IconSparkle } from './Icons';

/** 每个义项默认展示的主例组数 */
const EXAMPLES_PER_SENSE = 3;
/** 折叠状态下每条主例下最多跟几条子例（「いい」一条主例下面能挂 40 多条）*/
const SUBS_PER_EXAMPLE = 2;
/** 超过这个义项数就折叠尾部义项 */
const SENSES_SHOWN = 4;
/** 一部词典下默认展示的词条数 */
const ENTRIES_PER_DICT = 5;
/** 末尾「複合語・派生」区默认展示的条数（学校、コンピューター这类词能有50 条）*/
const TRAILING_SHOWN = 6;
/** 例句多于这个数才在词条头部给「全部展开」开关 */
const EXPAND_ALL_THRESHOLD = 4;

export function Tag({ tag }: { tag: TagInfo }): JSX.Element {
  const category = (tag.category || 'default').replace(/[^a-zA-Z0-9_-]/g, '-');
  return (
    <span className={`tag tag-cat-${category}`} title={tag.notes || tag.name}>
      {tag.name}
    </span>
  );
}

function CopyButton({ text }: { text: string }): JSX.Element {
  const [done, setDone] = useState(false);
  const copy = useCallback(() => {
    const fallback = (): void => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } finally {
        document.body.removeChild(ta);
      }
    };
    const finish = (): void => {
      setDone(true);
      window.setTimeout(() => setDone(false), 1200);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(finish, () => {
        fallback();
        finish();
      });
    } else {
      fallback();
      finish();
    }
  }, [text]);

  return (
    <button className="btn ghost sm" type="button" onClick={copy} title="复制排版后的释义">
      {done ? <IconCheck /> : <IconCopy />}
    </button>
  );
}

/* ══════════════════════ 研究社式纯文本释义的渲染 ══════════════════════ */

const MARK_TITLE: Record<string, string> = {
  us: '美式用法',
  literary: '文语／旧式用法',
};

interface RunProps {
  items: Inline[];
  onLookup: (query: string) => void;
}

/** 行内记号 → 元素 */
function InlineRun({ items, onLookup }: RunProps): JSX.Element {
  return (
    <>
      {items.map((it, i) => {
        switch (it.t) {
          case 'text':
            return <Fragment key={i}>{it.v}</Fragment>;
          case 'ruby':
            return (
              <ruby key={i}>
                {it.base}
                <rp>（</rp>
                <rt>{it.rt}</rt>
                <rp>）</rp>
              </ruby>
            );
          case 'domain':
            return (
              <span className="gx-domain" key={i} title="语义・使用场合限定">
                {it.v}
              </span>
            );
          case 'field':
            return (
              <span className="gx-field" key={i} title="专业领域">
                {it.v}
              </span>
            );
          case 'usage':
            return (
              <span className="gx-usage" key={i} title="用法说明">
                {it.v}
              </span>
            );
          case 'etym':
            return (
              <span className="gx-etym" key={i} title="词源">
                {it.v}
              </span>
            );
          case 'register':
            return (
              <span className="gx-register" key={i} title="语域・地域标签">
                {it.v}
              </span>
            );
          case 'gloss-note':
            return (
              <span className="gx-glossnote" key={i}>
                （{it.v}）
              </span>
            );
          case 'alt':
            // 备选项里还可能嵌着《口》、*word 这些记号，再跑一遍行内解析
            return (
              <span className="gx-alt" key={i} title={`可替换为 ${it.alts.join(' / ')}`}>
                {it.main.length > 0 ? <InlineRun items={it.main} onLookup={onLookup} /> : null}
                <span className="gx-alt-opt">
                  [
                  {it.alts.map((a, k) => (
                    <Fragment key={k}>
                      {k > 0 ? ', ' : null}
                      <InlineRun items={parseInline(a)} onLookup={onLookup} />
                    </Fragment>
                  ))}
                  ]
                </span>
              </span>
            );
          case 'xref':
            if (!it.query) {
              return (
                <span className="gx-xref off" key={i}>
                  {it.marker}
                  {it.v}
                </span>
              );
            }
            return (
              <button
                className="gx-xref"
                key={i}
                type="button"
                title={`查询「${it.query}」`}
                onClick={() => onLookup(it.query)}
              >
                <span className="gx-xref-mark" aria-hidden="true">
                  {it.marker}
                </span>
                <span className="jp">{it.v}</span>
              </button>
            );
          case 'sep':
            return (
              <span className="gx-sep" key={i} aria-hidden="true">
                ｜
              </span>
            );
          case 'note':
            return (
              <span className="gx-inline-note" key={i}>
                {it.v}
              </span>
            );
          case 'mark':
            return (
              <span className={`gx-mark ${it.flavor}`} key={i} title={MARK_TITLE[it.flavor]}>
                {it.v}
              </span>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

/**
 * 词头行。绝大多数情况下它与词条头重复（谓/いい），已经在 EntryView 里合并掉；
 * 只有当释义里的词形/读音与词条头不一致（异体字、通过活用还原命中等）才会渲染。
 */
function HeadwordLine({ head }: { head: HeadwordBlock }): JSX.Element {
  return (
    <div className="gx-head">
      <span className="gx-head-label">辞書词头</span>
      {head.kanji ? <span className="gx-head-kanji jp">{head.kanji}</span> : null}
      <span className={head.kanji ? 'gx-head-kana jp' : 'gx-head-kanji jp'}>{head.kana}</span>
      {head.homographIndex ? (
        <span className="gx-head-idx" title="同音异义词序号">
          {head.homographIndex}
        </span>
      ) : null}
    </div>
  );
}

/** 研究社把作品名、歌名等词头写成「光学」，比对时要把引号去掉（AST 里仍保留原文）*/
function unquote(s: string): string {
  return s.replace(/^[「『]([\s\S]*)[」』]$/, '$1');
}

/** 词头行是否与词条头完全重复（重复就不再渲染它） */
function headwordIsRedundant(head: HeadwordBlock | null, term: string, reading: string): boolean {
  if (!head) return true;
  const kana = unquote(head.kana);
  const form = head.kanji ? unquote(head.kanji) : kana;
  if (form !== term) return false;
  return !kana || kana === reading || kana === term;
}

interface BlockProps {
  block: GlossBlock;
  onLookup: (query: string) => void;
  /** 折叠状态下限制子例数量 */
  subLimit?: number;
  /** 义项下只有一组主例时拉平层级，避免被误读成「父项 + 子项」 */
  flat?: boolean;
}

/** 例句 / 注记 / 子见出し / 兜底段落 */
function LeafBlock({ block, onLookup, subLimit = Infinity, flat = false }: BlockProps): JSX.Element | null {
  switch (block.kind) {
    case 'example':
      return (
        <div className={`gx-ex ${block.level === 'primary' ? 'primary' : 'sub'}`}>
          <div className="gx-ex-ja jp">
            <span className="gx-ex-mark" aria-hidden="true" />
            {block.domain ? <span className="gx-domain">{block.domain}</span> : null}
            <InlineRun items={block.ja} onLookup={onLookup} />
          </div>
          {block.translation ? (
            <div className="gx-ex-tr">
              <InlineRun items={block.translation} onLookup={onLookup} />
            </div>
          ) : null}
          {block.children.length > 0 ? (
            <div className={flat ? 'gx-exsub flat' : 'gx-exsub'}>
              {block.children.slice(0, subLimit).map((c, i) => (
                <LeafBlock key={i} block={c} onLookup={onLookup} />
              ))}
            </div>
          ) : null}
        </div>
      );
    case 'note':
      return (
        <p className="gx-note">
          <InlineRun items={block.content} onLookup={onLookup} />
        </p>
      );
    case 'subentry':
      return (
        <div className="gx-sub">
          <div className="gx-sub-ja jp">
            {block.marker ? (
              <span className="gx-sub-mark" aria-hidden="true">
                {block.marker}
              </span>
            ) : null}
            {block.domain ? <span className="gx-domain">{block.domain}</span> : null}
            <InlineRun items={block.ja} onLookup={onLookup} />
          </div>
          {block.translation ? (
            <div className="gx-sub-tr">
              <InlineRun items={block.translation} onLookup={onLookup} />
            </div>
          ) : null}
        </div>
      );
    case 'paragraph':
      return (
        <p className="gx-para">
          <InlineRun items={block.content} onLookup={onLookup} />
        </p>
      );
    default:
      return null;
  }
}

interface SenseProps {
  sense: SenseBlock;
  expandAll: boolean;
  onLookup: (query: string) => void;
}

function SenseView({ sense, expandAll, onLookup }: SenseProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const full = expandAll || open;
  const groups = sense.children.filter((c) => c.kind === 'example');
  const limit = full ? Infinity : EXAMPLES_PER_SENSE;
  const subLimit = full ? Infinity : SUBS_PER_EXAMPLE;

  // 只有一组主例时，子例不再另起一级缩进——否则“1 条主例 + 2 条子例”
  // 会被看成“第一条是标题，后两条是它的子项”
  const visibleGroups = Math.min(groups.length, limit);
  const flat = visibleGroups <= 1;

  // 折叠以「主例组」为单位：一条 ► 及其下面的 ・ 子例算一组
  let shown = 0;
  let rendered = 0;
  const kids: JSX.Element[] = [];
  sense.children.forEach((child, i) => {
    if (child.kind === 'example') {
      shown++;
      if (shown > limit) return;
      rendered += 1 + Math.min(child.children.length, subLimit);
    }
    kids.push(<LeafBlock key={i} block={child} onLookup={onLookup} subLimit={subLimit} flat={flat} />);
  });
  const total = countExamples(groups);
  const hidden = full ? 0 : Math.max(0, total - rendered);

  const hasHeader = !!sense.number || !!sense.domain || sense.content.length > 0;

  return (
    <section className="gx-sense">
      {hasHeader ? (
        <div className="gx-sense-head">
          {sense.number ? <span className="gx-num">{sense.number}</span> : null}
          <p className="gx-sense-body">
            {sense.domain ? <span className="gx-domain">{sense.domain}</span> : null}
            <InlineRun items={sense.content} onLookup={onLookup} />
          </p>
        </div>
      ) : null}
      {kids.length > 0 ? <div className={flat ? 'gx-exlist flat' : 'gx-exlist'}>{kids}</div> : null}
      {hidden > 0 ? (
        <button className="gx-more" type="button" onClick={() => setOpen(true)}>
          展开其余 {hidden} 条例句
        </button>
      ) : null}
      {!expandAll && open && total > EXAMPLES_PER_SENSE ? (
        <button className="gx-more" type="button" onClick={() => setOpen(false)}>
          收起例句
        </button>
      ) : null}
    </section>
  );
}

interface GlossTextProps {
  blocks: GlossBlock[];
  expandAll: boolean;
  /** 词头行与词条头重复时传 false */
  showHeadword: boolean;
  onLookup: (query: string) => void;
}

function StructuredGloss({ blocks, expandAll, showHeadword, onLookup }: GlossTextProps): JSX.Element {
  const [allSenses, setAllSenses] = useState(false);
  const [allTrailing, setAllTrailing] = useState(false);

  const head = blocks.find((b): b is HeadwordBlock => b.kind === 'headword');
  const senses = blocks.filter((b): b is SenseBlock => b.kind === 'sense');
  const trailing = blocks.filter((b) => b.kind !== 'headword' && b.kind !== 'sense');

  const showAll = expandAll || allSenses || senses.length <= SENSES_SHOWN;
  const visible = showAll ? senses : senses.slice(0, SENSES_SHOWN);
  const showTrailing = expandAll || allTrailing || trailing.length <= TRAILING_SHOWN;

  return (
    <div className="gx">
      {head && showHeadword ? <HeadwordLine head={head} /> : null}
      {visible.map((s, i) => (
        <SenseView key={s.number ?? `s${i}`} sense={s} expandAll={expandAll} onLookup={onLookup} />
      ))}
      {!showAll ? (
        <button className="gx-more block" type="button" onClick={() => setAllSenses(true)}>
          展开其余 {senses.length - SENSES_SHOWN} 个义项
        </button>
      ) : null}
      {trailing.length > 0 ? (
        <div className="gx-trailing">
          <div className="gx-trailing-label">
            複合語・派生<span className="gx-trailing-count">{trailing.length}</span>
          </div>
          {(showTrailing ? trailing : trailing.slice(0, TRAILING_SHOWN)).map((b, i) => (
            <LeafBlock key={i} block={b} onLookup={onLookup} />
          ))}
          {!showTrailing ? (
            <button className="gx-more" type="button" onClick={() => setAllTrailing(true)}>
              展开其余 {trailing.length - TRAILING_SHOWN} 条複合語
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ══════════════════════ 其它释义形态 ══════════════════════ */

interface NodeProps {
  node: GlossaryNode;
  dictId: number;
  onLookup: (query: string) => void;
}

/**
 * MDX HTML 已在服务端消毒。这里仍只把它放进词典专属容器，确保配套 CSS
 * 只能命中当前词条；内部 `?query=` 链接复用详情面板现有的查词历史。
 */
function MdictHtml({ html, dictId, onLookup }: { html: string; dictId: number; onLookup: (query: string) => void }): JSX.Element {
  useEffect(() => {
    const id = `mdx-style-${dictId}`;
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = `/api/dictionaries/${dictId}/style.css`;
    document.head.appendChild(link);
  }, [dictId]);

  const handleClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const origin = event.target;
      if (!(origin instanceof Element)) return;
      const anchor = origin.closest('a[href]');
      const href = anchor?.getAttribute('href') ?? '';
      if (!href.startsWith('?')) return;
      const query = new URLSearchParams(href.slice(1)).get('query')?.trim();
      if (!query) return;
      event.preventDefault();
      onLookup(query);
    },
    [onLookup],
  );

  return (
    <div
      className={`mdx-html mdx-dict-${dictId}`}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function PlainNode({ node, dictId, onLookup }: NodeProps): JSX.Element | null {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'text') return <p className="gloss-line">{node.text}</p>;
  if (node.type === 'image') {
    return (
      <figure className="gloss-figure">
        <img
          src={mediaUrl(dictId, node.path)}
          alt={typeof node.description === 'string' ? node.description : ''}
          title={node.title}
          width={node.width}
          height={node.height}
          loading="lazy"
        />
        {node.description ? <figcaption className="faint">{node.description}</figcaption> : null}
      </figure>
    );
  }
  if (node.type === 'structured-content') {
    return <StructuredContent content={node.content} dictId={dictId} onInternalLookup={onLookup} />;
  }
  if (node.type === 'html') {
    return <MdictHtml html={node.html} dictId={dictId} onLookup={onLookup} />;
  }
  return null;
}

function PlainFallback({ glossary }: { glossary: GlossaryNode[] }): JSX.Element {
  const lines = glossaryToLines(glossary);
  return (
    <div className="sc-fallback">
      <div className="faint sc-fallback-hint">该词典的排版无法渲染，已降级为纯文本</div>
      <ul className="gloss-plain">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

/* ══════════════════════ 词条 ══════════════════════ */

/** 一条词条被切成若干可渲染片段，解析只做一次 */
type Part =
  | { kind: 'blocks'; blocks: GlossBlock[]; examples: number; head: HeadwordBlock | null }
  | { kind: 'plain'; text: string }
  | { kind: 'node'; node: GlossaryNode };

interface BuiltEntry {
  parts: Part[];
  examples: number;
  copyText: string;
  /** 整条词条的第一个词头，罗马字/同音号会提到词条头上去显示 */
  head: HeadwordBlock | null;
}

function buildParts(glossary: GlossaryNode[]): BuiltEntry {
  const parts: Part[] = [];
  const copy: string[] = [];
  let examples = 0;
  let head: HeadwordBlock | null = null;
  for (const node of glossary) {
    if (typeof node === 'string') {
      if (looksStructured(node)) {
        const blocks = parseGlossText(node);
        const n = countExamples(blocks);
        examples += n;
        const h = blocks.find((b): b is HeadwordBlock => b.kind === 'headword') ?? null;
        if (!head) head = h;
        parts.push({ kind: 'blocks', blocks, examples: n, head: h });
        copy.push(blocksToPlainText(blocks));
      } else {
        parts.push({ kind: 'plain', text: node });
        copy.push(node);
      }
      continue;
    }
    parts.push({ kind: 'node', node });
    const text = glossaryNodeToText(node);
    if (text) copy.push(text);
  }
  return { parts, examples, copyText: copy.join('\n\n'), head };
}

interface EntryProps {
  entry: DictEntry;
  onInternalLookup: (query: string) => void;
  onAskAi: (entry: DictEntry) => void;
}

function EntryView({ entry, onInternalLookup, onAskAi }: EntryProps): JSX.Element {
  const [expandAll, setExpandAll] = useState(false);
  const { parts, examples, copyText, head } = useMemo(() => buildParts(entry.glossary), [entry.glossary]);

  // 部分词条的 reading 字段为空，用释义词头行里的假名补上，避免为了一个读音多排一行
  const reading = entry.reading || (head?.kanji ? head.kana : '') || '';

  // 多条纯字符串释义（JMdict 风格）仍然用有序列表
  const simpleList =
    entry.glossary.length > 1 && parts.every((p) => p.kind === 'plain')
      ? (parts as { kind: 'plain'; text: string }[])
      : null;

  return (
    <article className="entry">
      <div className="entry-head">
        <span className="entry-term jp">{entry.term}</span>
        {reading && reading !== entry.term ? <span className="entry-reading jp">{reading}</span> : null}
        {/* 同音号与罗马字从辞典词头行提上来，跟在读音后面 */}
        {head?.homographIndex ? (
          <span className="entry-idx" title="同音异义词序号">
            {head.homographIndex}
          </span>
        ) : null}
        {head?.romaji ? <span className="entry-romaji">{head.romaji}</span> : null}
        {entry.termTags.map((t, i) => (
          <Tag key={`tt${i}`} tag={t} />
        ))}
        {entry.definitionTags.map((t, i) => (
          <Tag key={`dt${i}`} tag={t} />
        ))}
        <span className="entry-actions">
          {examples > EXPAND_ALL_THRESHOLD ? (
            <button
              className="btn ghost sm gx-toggle"
              type="button"
              onClick={() => setExpandAll((v) => !v)}
              title={expandAll ? '每个义项只留 3 条例句' : `展开全部 ${examples} 条例句`}
            >
              {expandAll ? '精简' : `例句 ${examples}`}
            </button>
          ) : null}
          <CopyButton text={copyText || entry.term} />
          <button className="btn ghost sm" type="button" title="就这条释义问 AI" onClick={() => onAskAi(entry)}>
            <IconSparkle />
          </button>
        </span>
      </div>

      {entry.matchedVia && entry.matchedVia.length > 1 ? (
        <div className="entry-via jp">{entry.matchedVia.join(' → ')}</div>
      ) : null}

      <ErrorBoundary resetKey={entry} fallback={<PlainFallback glossary={entry.glossary} />}>
        <div className="gloss">
          {simpleList ? (
            <ol className="gloss-list">
              {simpleList.map((p, i) => (
                <li key={i}>{p.text}</li>
              ))}
            </ol>
          ) : (
            parts.map((p, i) => {
              if (p.kind === 'blocks') {
                return (
                  <StructuredGloss
                    key={i}
                    blocks={p.blocks}
                    expandAll={expandAll}
                    showHeadword={!headwordIsRedundant(p.head, entry.term, reading)}
                    onLookup={onInternalLookup}
                  />
                );
              }
              if (p.kind === 'plain') return <p className="gloss-line" key={i}>{p.text}</p>;
              return <PlainNode key={i} node={p.node} dictId={entry.dictId} onLookup={onInternalLookup} />;
            })
          )}
        </div>
      </ErrorBoundary>
    </article>
  );
}

/* ══════════════════════ 词典分组 ══════════════════════ */

interface GroupProps {
  title: string;
  items: DictEntry[];
  onInternalLookup: (query: string) => void;
  onAskAi: (entry: DictEntry) => void;
}

function DictGroup({ title, items, onInternalLookup, onAskAi }: GroupProps): JSX.Element {
  const [all, setAll] = useState(false);
  const visible = all ? items : items.slice(0, ENTRIES_PER_DICT);
  const hidden = items.length - visible.length;

  return (
    <section className="dictgroup">
      <div className="dt">
        <span className="dt-title">{title}</span>
        <span className="dt-count">{items.length} 条</span>
      </div>
      {visible.map((e, i) => (
        <EntryView key={`${e.sequence}-${i}`} entry={e} onInternalLookup={onInternalLookup} onAskAi={onAskAi} />
      ))}
      {hidden > 0 ? (
        <button className="gx-more block" type="button" onClick={() => setAll(true)}>
          显示其余 {hidden} 条词条
        </button>
      ) : null}
      {all && items.length > ENTRIES_PER_DICT ? (
        <button className="gx-more block" type="button" onClick={() => setAll(false)}>
          只看前 {ENTRIES_PER_DICT} 条
        </button>
      ) : null}
    </section>
  );
}

interface Props {
  entries: DictEntry[];
  onInternalLookup: (query: string) => void;
  onAskAi: (entry: DictEntry) => void;
}

export function GlossaryView({ entries, onInternalLookup, onAskAi }: Props): JSX.Element {
  // 保持服务端给出的顺序（已按词典优先级排好），仅做相邻分组
  const groups: { title: string; items: DictEntry[] }[] = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (last && last.title === e.dictTitle) last.items.push(e);
    else groups.push({ title: e.dictTitle, items: [e] });
  }

  return (
    <div className="glossary">
      {groups.map((g, gi) => (
        <DictGroup
          key={`${g.title}-${gi}`}
          title={g.title}
          items={g.items}
          onInternalLookup={onInternalLookup}
          onAskAi={onAskAi}
        />
      ))}
    </div>
  );
}
