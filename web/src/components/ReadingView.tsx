/**
 * 解析结果阅读区（居中单列，文学作品式排版）。
 *
 * 性能设计：
 * - 句子分块渲染，块内 chip 用 memo；块本身也 memo，选中态只让「含选中词的那一句」重渲染
 * - 点击 / 键盘 / 悬停全部走事件委托，chip 上零 handler
 * - 句子数多时用 IntersectionObserver 懒挂载（挂载后不再卸载，避免滚动抖动）
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from 'react';
import type { AnalysisResult, Pos, Sentence, Word } from '@shared/types';
import { useAppState, useDispatch, useWordIndex, type FuriganaMode } from '../state';
import { WordChip } from './WordChip';
import { WordTooltip } from './WordTooltip';
import { ParticleArcs } from './ParticleArcs';
import { TranslationControls, TranslationNotice, useTranslation } from './Translation';

/** 超过这个句子数才启用懒挂载 */
const LAZY_THRESHOLD = 24;

const POS_LEGEND: { pos: Pos; label: string }[] = [
  { pos: 'noun', label: '名词' },
  { pos: 'pronoun', label: '代词' },
  { pos: 'propernoun', label: '专有名词' },
  { pos: 'number', label: '数词' },
  { pos: 'verb', label: '动词' },
  { pos: 'i-adjective', label: 'い形容词' },
  { pos: 'na-adjective', label: 'な形容词' },
  { pos: 'adverb', label: '副词' },
  { pos: 'prenominal', label: '连体词' },
  { pos: 'conjunction', label: '接续词' },
  { pos: 'interjection', label: '感叹词' },
  { pos: 'particle', label: '助词' },
  { pos: 'auxiliary', label: '助动词' },
  { pos: 'prefix', label: '接头词' },
  { pos: 'suffix', label: '接尾词' },
  { pos: 'counter', label: '量词' },
  { pos: 'other', label: '其他' },
];

/* ────────────────────────────── 懒挂载 ────────────────────────────── */

function useSeen(ref: RefObject<Element>, lazy: boolean): boolean {
  const [seen, setSeen] = useState(!lazy);
  useEffect(() => {
    if (seen) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: '900px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}

/* ────────────────────────────── 句子块 ────────────────────────────── */

interface SentenceBlockProps {
  sentence: Sentence;
  words: Word[];
  furigana: FuriganaMode;
  showArcs: boolean;
  /** 仅当选中词属于本句时非 null，其他句子的 props 保持不变从而跳过重渲染 */
  selectedWordId: number | null;
  lazy: boolean;
  /** 译文：undefined = 未开启，null = 加载中 */
  translation: string | null | undefined;
}

function SentenceBlockImpl({
  sentence,
  words,
  furigana,
  showArcs,
  selectedWordId,
  lazy,
  translation,
}: SentenceBlockProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  // 弧线单独挂在句子正文的包裹层上：撑高时不会盖到下方的译文
  const bodyRef = useRef<HTMLDivElement>(null);
  const seen = useSeen(ref, lazy);
  const hasParticle = useMemo(() => words.some((w) => w.particle), [words]);

  if (!seen) {
    const estimated = Math.max(64, Math.ceil([...sentence.text].length / 22) * 64);
    return <div ref={ref} className="sentence-placeholder" style={{ height: estimated }} aria-hidden="true" />;
  }

  return (
    <div ref={ref} className="sentence" data-sentence-index={sentence.index}>
      <span className="sentence-index">{String(sentence.index + 1).padStart(2, '0')}</span>
      <div className="sentence-body" ref={bodyRef}>
        <div className="sentence-line">
          {words.map((w) => (
            <WordChip key={w.id} word={w} furigana={furigana} selected={w.id === selectedWordId} />
          ))}
        </div>
        {showArcs && hasParticle ? (
          <ParticleArcs containerRef={bodyRef} words={words} revision={`${furigana}:${words.length}`} />
        ) : null}
      </div>
      {translation !== undefined ? (
        translation === null ? (
          <div className="sentence-tr is-loading" aria-hidden="true">
            <span className="sk" />
            <span className="sk" />
          </div>
        ) : (
          <div className="sentence-tr">{translation || '—'}</div>
        )
      ) : null}
    </div>
  );
}

const SentenceBlock = memo(SentenceBlockImpl);

/* ────────────────────────────── 主体 ────────────────────────────── */

const analysisIds = new WeakMap<AnalysisResult, number>();
let analysisSeq = 0;

function analysisId(a: AnalysisResult): number {
  let id = analysisIds.get(a);
  if (id === undefined) {
    id = ++analysisSeq;
    analysisIds.set(a, id);
  }
  return id;
}

export function ReadingView(): JSX.Element {
  const { analysis, analyzing, analyzeError, settings, selectedWordId, demo } = useAppState();
  const dispatch = useDispatch();
  const rootRef = useRef<HTMLDivElement>(null);
  const { byId, bySentence } = useWordIndex(analysis);
  const tr = useTranslation();

  const selectedSentence = selectedWordId != null ? byId.get(selectedWordId)?.sentenceIndex ?? null : null;

  const onClick = useCallback(
    (ev: MouseEvent<HTMLDivElement>) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      const el = target.closest<HTMLElement>('[data-word-id]');
      if (!el) return;
      const id = Number(el.dataset.wordId);
      const word = byId.get(id);
      if (!word || word.pos === 'symbol' || word.pos === 'whitespace') return;
      el.focus({ preventScroll: true });
      dispatch({ type: 'word/select', wordId: id });
    },
    [byId, dispatch],
  );

  const onKeyDown = useCallback(
    (ev: KeyboardEvent<HTMLDivElement>) => {
      const root = rootRef.current;
      if (!root) return;
      const active = document.activeElement;
      const current = active instanceof HTMLElement ? active.closest<HTMLElement>('[data-word-id]') : null;

      if (ev.key === 'Escape') {
        dispatch({ type: 'word/select', wordId: null });
        return;
      }
      if ((ev.key === 'Enter' || ev.key === ' ') && current) {
        ev.preventDefault();
        dispatch({ type: 'word/select', wordId: Number(current.dataset.wordId) });
        return;
      }
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;

      const chips = Array.from(root.querySelectorAll<HTMLElement>('.word[tabindex="0"]'));
      if (chips.length === 0) return;
      ev.preventDefault();
      const idx = current ? chips.indexOf(current) : -1;
      const nextIdx =
        idx < 0 ? 0 : Math.min(chips.length - 1, Math.max(0, idx + (ev.key === 'ArrowRight' ? 1 : -1)));
      const next = chips[nextIdx];
      next.focus();
      dispatch({ type: 'word/select', wordId: Number(next.dataset.wordId) });
    },
    [dispatch],
  );

  // 从右栏（助词成分卡片等）跳转过来时，把目标词滚进视野
  useEffect(() => {
    if (selectedWordId == null) return;
    const root = rootRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-word-id="${selectedWordId}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 110 || r.bottom > window.innerHeight - 24) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [selectedWordId]);

  const usedPos = useMemo(() => {
    const set = new Set<Pos>();
    if (analysis) for (const w of analysis.words) if (w.pos !== 'symbol' && w.pos !== 'whitespace') set.add(w.pos);
    return set;
  }, [analysis]);

  const lazy = !!analysis && analysis.sentences.length > LAZY_THRESHOLD;
  const rev = analysis ? analysisId(analysis) : 0;
  /** 译文开启且能真的请求时，未到货的句子显示占位骨架 */
  const showTr = tr.enabled && tr.supported && !demo;

  if (!analysis) {
    return (
      <section className="reading">
        <div className="reading-inner">
          {analyzeError ? (
            <div className="reading-notes" style={{ paddingTop: 20 }}>
              <div className="banner error">
                <span>✕</span>
                <span>{analyzeError}</span>
              </div>
            </div>
          ) : null}
          {analyzing ? (
            <div className="empty" style={{ minHeight: 260 }}>
              <span className="spin" />
              <p>正在分析…</p>
            </div>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section className="reading" ref={rootRef} onClick={onClick} onKeyDown={onKeyDown} role="presentation">
      <div className="reading-inner">
        <Toolbar />

        {settings.showLegend && usedPos.size > 0 ? (
          <div className="legend">
            {POS_LEGEND.filter((p) => usedPos.has(p.pos)).map((p) => (
              <span key={p.pos} className={`pos-${p.pos}`}>
                <i />
                {p.label}
              </span>
            ))}
            <span className="pos-other">
              <i style={{ borderTop: '2px dashed var(--fg-faint)', background: 'none', height: 0 }} />
              未收录
            </span>
          </div>
        ) : null}

        {analysis.warnings.length || analyzeError ? (
          <div className="reading-notes">
            {analysis.warnings.length ? (
              <div className="banner warn">
                <span>⚠</span>
                <span>{analysis.warnings.join('；')}</span>
              </div>
            ) : null}
            {analyzeError ? (
              <div className="banner error">
                <span>✕</span>
                <span>{analyzeError}</span>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="reading-body">
          {analysis.sentences.map((s) => (
            <SentenceBlock
              key={`${rev}:${s.index}`}
              sentence={s}
              words={bySentence.get(s.index) ?? []}
              furigana={settings.furigana}
              showArcs={settings.showArcs}
              selectedWordId={selectedSentence === s.index ? selectedWordId : null}
              lazy={lazy}
              translation={showTr ? tr.lines[s.index] ?? null : undefined}
            />
          ))}
        </div>
      </div>

      <WordTooltip containerRef={rootRef} byId={byId} revision={rev} />
    </section>
  );
}

/* ────────────────────────────── 工具条 ────────────────────────────── */

function Toolbar(): JSX.Element {
  const { settings, analysis, analyzing, demo } = useAppState();
  const dispatch = useDispatch();

  const set = (patch: Partial<typeof settings>): void => dispatch({ type: 'settings/patch', patch });

  return (
    <div className="reading-toolbar">
      <div className="tb-controls">
        <div className="group">
          <span>振假名</span>
          <div className="seg" role="group" aria-label="振假名显示方式">
            <button type="button" aria-pressed={settings.furigana === 'all'} onClick={() => set({ furigana: 'all' })}>
              全部
            </button>
            <button
              type="button"
              aria-pressed={settings.furigana === 'unknown'}
              onClick={() => set({ furigana: 'unknown' })}
              title="只给未收录或低频的汉字词注音"
            >
              仅生词
            </button>
            <button type="button" aria-pressed={settings.furigana === 'off'} onClick={() => set({ furigana: 'off' })}>
              关闭
            </button>
          </div>
        </div>

        <button
          className="tgl"
          type="button"
          aria-pressed={settings.showArcs}
          onClick={() => set({ showArcs: !settings.showArcs })}
          title="在句子下方画出助词与前后成分的连接"
        >
          助词关系图
        </button>

        <TranslationControls />

        <button
          className="tgl"
          type="button"
          aria-pressed={settings.showLegend}
          onClick={() => set({ showLegend: !settings.showLegend })}
        >
          词性图例
        </button>
      </div>

      <div className="tb-meta">
        {analyzing ? (
          <span className="group">
            <span className="spin" /> 分析中
          </span>
        ) : null}
        {demo ? <span className="chiptag" style={{ color: 'var(--warn)' }}>演示数据</span> : null}
        {analysis ? (
          <span className="stats">
            {analysis.stats.sentences} 句 · {analysis.stats.words} 词
            {analysis.stats.unknownWords > 0 ? ` · ${analysis.stats.unknownWords} 未收录` : ''}
            {` · ${analysis.stats.ms} ms`}
          </span>
        ) : null}
      </div>

      <TranslationNotice />
    </div>
  );
}
