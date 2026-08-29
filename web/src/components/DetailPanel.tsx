/**
 * 右栏「详情」：词头 / 声调 / 形态 / 词素 / 助词详解 / 词典释义 / 汉字。
 * 自带前进后退历史——在释义里点内部链接或点助词成分卡片都会入栈。
 *
 * 排版目标：像一页排印考究的纸质辞典内页。分区标题用细双线，
 * 正文用衬线，所有间距都按 440px 窄栏调过，不允许横向溢出。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DictEntry, LookupResponse, Word } from '@shared/types';
import { toRomaji } from '@shared/kana';
import { glossaryToText } from '@shared/glossary';
import { errorText, lookup } from '../api';
import { mockLookup } from '../mock';
import { useAppState, useDispatch, useWordIndex } from '../state';
import { GlossaryView } from './GlossaryView';
import { KanjiView } from './KanjiView';
import { PitchCurve } from './PitchCurve';
import { IconChevronLeft, IconChevronRight, IconClose, IconSparkle } from './Icons';

type Target = { kind: 'word'; wordId: number } | { kind: 'query'; text: string };

function targetKey(t: Target | null): string {
  if (!t) return '';
  return t.kind === 'word' ? `w:${t.wordId}` : `q:${t.text}`;
}

interface LookupState {
  loading: boolean;
  data: LookupResponse | null;
  error: string | null;
}

const EMPTY_LOOKUP: LookupState = { loading: false, data: null, error: null };

/** 分区标题：小号、放开字距、细双线 */
function SectionHead({ children, count }: { children: ReactNode; count?: ReactNode }): JSX.Element {
  return (
    <h3 className="sec-head">
      <span className="sec-label">{children}</span>
      {count != null ? <span className="count">{count}</span> : null}
    </h3>
  );
}

export function DetailPanel(): JSX.Element {
  const { analysis, selectedWordId, demo } = useAppState();
  const dispatch = useDispatch();
  const { byId } = useWordIndex(analysis);

  const [nav, setNav] = useState<{ items: Target[]; idx: number }>({ items: [], idx: -1 });
  const [look, setLook] = useState<LookupState>(EMPTY_LOOKUP);
  const lastSelection = useRef<number | null>(null);

  const current: Target | null = nav.idx >= 0 ? nav.items[nav.idx] ?? null : null;
  const key = targetKey(current);

  const push = useCallback((t: Target) => {
    setNav((n) => ({ items: [...n.items.slice(0, n.idx + 1), t], idx: n.idx + 1 }));
  }, []);

  // 新的分析结果 → 清空历史
  useEffect(() => {
    setNav({ items: [], idx: -1 });
    lastSelection.current = null;
  }, [analysis]);

  // 外部选中变化 → 入栈
  useEffect(() => {
    if (selectedWordId == null) return;
    if (lastSelection.current === selectedWordId) return;
    lastSelection.current = selectedWordId;
    push({ kind: 'word', wordId: selectedWordId });
  }, [push, selectedWordId]);

  const goto = useCallback(
    (idx: number) => {
      const t = nav.items[idx];
      if (!t) return;
      setNav((n) => ({ ...n, idx }));
      if (t.kind === 'word') {
        lastSelection.current = t.wordId;
        dispatch({ type: 'word/select', wordId: t.wordId });
      }
    },
    [dispatch, nav.items],
  );

  const onInternalLookup = useCallback((query: string) => push({ kind: 'query', text: query }), [push]);

  const word: Word | null = current?.kind === 'word' ? byId.get(current.wordId) ?? null : null;

  /* 查词 */
  useEffect(() => {
    if (!current) {
      setLook(EMPTY_LOOKUP);
      return;
    }
    const req =
      current.kind === 'query'
        ? { surface: current.text }
        : word
          ? { surface: word.surface, lemma: word.lemma || undefined, reading: word.reading || undefined }
          : null;
    if (!req) {
      setLook(EMPTY_LOOKUP);
      return;
    }

    if (demo) {
      setLook({ loading: false, data: mockLookup(req), error: null });
      return;
    }

    const ctrl = new AbortController();
    setLook({ loading: true, data: null, error: null });
    lookup(req, ctrl.signal).then(
      (data) => setLook({ loading: false, data, error: null }),
      (err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setLook({ loading: false, data: null, error: errorText(err) });
      },
    );
    return () => ctrl.abort();
    // word 由 key 唯一确定，不必进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, demo]);

  const askAi = useCallback(
    (prompt: string) => {
      dispatch({ type: 'ai/seed', prompt, wordId: word?.id ?? null, send: false });
    },
    [dispatch, word],
  );

  const askAboutEntry = useCallback(
    (entry: DictEntry) => {
      const text = glossaryToText(entry.glossary, 400);
      askAi(
        `请解释「${entry.term}${entry.reading && entry.reading !== entry.term ? `（${entry.reading}）` : ''}」这条释义，并给出用法要点：\n${text}`,
      );
    },
    [askAi],
  );

  const headTitle = current?.kind === 'query' ? current.text : word?.surface ?? '';

  return (
    <div className="detail">
      <div className="detail-nav">
        <button
          className="btn icon ghost"
          type="button"
          disabled={nav.idx <= 0}
          onClick={() => goto(nav.idx - 1)}
          title="后退"
          aria-label="后退"
        >
          <IconChevronLeft />
        </button>
        <button
          className="btn icon ghost"
          type="button"
          disabled={nav.idx >= nav.items.length - 1}
          onClick={() => goto(nav.idx + 1)}
          title="前进"
          aria-label="前进"
        >
          <IconChevronRight />
        </button>
        <span className="crumb jp">{headTitle}</span>
        {current ? (
          <button
            className="btn icon ghost"
            type="button"
            title="关闭（Esc）"
            aria-label="关闭详情"
            onClick={() => {
              setNav({ items: [], idx: -1 });
              lastSelection.current = null;
              dispatch({ type: 'word/select', wordId: null });
            }}
          >
            <IconClose />
          </button>
        ) : null}
      </div>

      <div className="detail-body">
        {!current ? (
          <div className="empty">
            <span className="big">詞</span>
            <p>点击左侧任意词单位查看词性、活用还原、助词用法与词典释义。</p>
            <p className="faint empty-hint">键盘：Tab / ← → 在词间移动，Enter 打开，Esc 关闭</p>
          </div>
        ) : null}

        {word ? <WordSections word={word} byId={byId} onAskAi={askAi} /> : null}

        {current?.kind === 'query' ? (
          <div className="wordhead">
            <div className="surface jp">{current.text}</div>
            <div className="sub">
              <span className="faint">来自词典内部链接</span>
            </div>
          </div>
        ) : null}

        {current ? <LookupSections state={look} onInternalLookup={onInternalLookup} onAskAi={askAboutEntry} /> : null}
      </div>
    </div>
  );
}

/* ────────────────────────────── 词本身的解析 ────────────────────────────── */

interface WordSectionsProps {
  word: Word;
  byId: Map<number, Word>;
  onAskAi: (prompt: string) => void;
}

function WordSections({ word, byId, onAskAi }: WordSectionsProps): JSX.Element {
  const dispatch = useDispatch();
  const romaji = word.particle?.romaji ?? toRomaji(word.reading || word.surface);
  const inflection = word.inflection;
  const particle = word.particle;

  return (
    <>
      <div className={`wordhead pos-${word.pos}`}>
        <div className="surface jp">
          {word.furigana.length > 0
            ? word.furigana.map((seg, i) =>
                seg.ruby ? (
                  <ruby key={i}>
                    {seg.text}
                    <rp>（</rp>
                    <rt>{seg.ruby}</rt>
                    <rp>）</rp>
                  </ruby>
                ) : (
                  <span key={i}>{seg.text}</span>
                ),
              )
            : word.surface}
        </div>
        <div className="sub">
          <span className="poslabel">{word.posLabel}</span>
          {word.reading ? <span className="jp">{word.reading}</span> : null}
          {romaji ? <span className="romaji-full">{romaji}</span> : null}
          {word.lemma && word.lemma !== word.surface ? (
            <span>
              <span className="faint">辞書形 </span>
              <span className="jp">{word.lemma}</span>
            </span>
          ) : null}
          {word.unknown ? <span className="chiptag">未收录</span> : null}
          {word.frequency.map((f, i) => (
            <span className="chiptag" key={i} title={f.dictTitle}>
              {f.dictTitle} {f.displayValue}
            </span>
          ))}
        </div>
        <div className="wordhead-actions">
          <button
            className="btn sm"
            type="button"
            onClick={() =>
              onAskAi(`请解释「${word.surface}」（${word.reading}，${word.posLabel}）在这句话里的意思和用法。`)
            }
          >
            <IconSparkle /> 问 AI
          </button>
        </div>
      </div>

      {word.pitch.length > 0 ? (
        <section className="section">
          <SectionHead>声调</SectionHead>
          {word.pitch.map((p, i) => (
            <PitchCurve key={i} pitch={p} />
          ))}
        </section>
      ) : null}

      {inflection ? (
        <section className="section">
          <SectionHead>形态分析</SectionHead>
          <dl className="kv">
            <dt>形态</dt>
            <dd>{inflection.form || '—'}</dd>
          </dl>
          {inflection.features.length > 0 ? (
            <div className="taglist gap-t">
              {inflection.features.map((f, i) => (
                <span className="tag tag-cat-partOfSpeech" key={i}>
                  {f}
                </span>
              ))}
            </div>
          ) : null}
          {inflection.steps.length > 0 ? (
            <ol className="steps">
              {inflection.steps.map((s, i) => (
                <li key={i}>
                  <span className="arrow" aria-hidden="true">
                    {i === 0 ? '' : '↓'}
                  </span>
                  <span className="jp">{s}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {inflection.notes ? <p className="note">{inflection.notes}</p> : null}
        </section>
      ) : null}

      {word.subTokens.length > 1 ? (
        <section className="section">
          <SectionHead count={`由 ${word.subTokens.length} 个成分构成`}>词素拆解</SectionHead>
          <div className="table-wrap">
            <table className="subtable">
              <thead>
                <tr>
                  <th>表层</th>
                  <th>读音</th>
                  <th>辞書形</th>
                  <th>词性</th>
                  <th>作用</th>
                </tr>
              </thead>
              <tbody>
                {word.subTokens.map((st, i) => (
                  <tr key={i}>
                    <td className="jp">{st.surface}</td>
                    <td className="jp">{st.reading}</td>
                    <td className="jp">{st.lemma}</td>
                    <td>
                      {st.posJa}
                      {st.conjForm ? <div className="faint sub-line">{st.conjForm}</div> : null}
                    </td>
                    <td className="role">{st.role ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {particle ? (
        <section className="section particle-section">
          <SectionHead count={particle.categoryLabel}>助词详解</SectionHead>

          {particle.before || particle.after ? (
            <div className="args">
              {particle.before ? (
                <button
                  className="arg-card"
                  type="button"
                  onClick={() => dispatch({ type: 'word/select', wordId: particle.before!.wordId })}
                  disabled={!byId.has(particle.before.wordId)}
                  title="跳到该成分"
                >
                  <span className="arole">前接 · {particle.before.role}</span>
                  <span className="asurface jp">{particle.before.surface}</span>
                </button>
              ) : (
                <span className="arg-card empty" aria-hidden="true" />
              )}
              <div className="arg-mid jp">{particle.particle}</div>
              {particle.after ? (
                <button
                  className="arg-card"
                  type="button"
                  onClick={() => dispatch({ type: 'word/select', wordId: particle.after!.wordId })}
                  disabled={!byId.has(particle.after.wordId)}
                  title="跳到该成分"
                >
                  <span className="arole">后接 · {particle.after.role}</span>
                  <span className="asurface jp">{particle.after.surface}</span>
                </button>
              ) : (
                <span className="arg-card empty" aria-hidden="true" />
              )}
            </div>
          ) : null}

          <div className="sense-card current">
            <div className="slabel">
              <span>{particle.sense.label}</span>
              <span className="badge-now">当前语境</span>
            </div>
            <div className="sdetail">{particle.sense.detail}</div>
            {particle.sense.example ? (
              <div className="sexample">
                <span className="jp">{particle.sense.example}</span>
                {particle.sense.exampleTranslation ? <em>{particle.sense.exampleTranslation}</em> : null}
              </div>
            ) : null}
          </div>

          {particle.structureNote ? (
            <p className="note">
              <span className="note-label">结构</span>
              {particle.structureNote}
            </p>
          ) : null}
          {particle.reason ? (
            <p className="note">
              <span className="note-label">判定依据</span>
              {particle.reason}
            </p>
          ) : null}

          {particle.allSenses.length > 1 ? (
            <details className="sense-all">
              <summary>全部 {particle.allSenses.length} 个义项</summary>
              <div className="sense-list">
                {particle.allSenses.map((s) => {
                  const on = s.key === particle.sense.key;
                  return (
                    <div className={on ? 'sense-card current' : 'sense-card'} key={s.key}>
                      <div className="slabel">
                        {on ? (
                          <span className="tick" aria-hidden="true">
                            ✓
                          </span>
                        ) : null}
                        <span>{s.label}</span>
                      </div>
                      <div className="sdetail">{s.detail}</div>
                      {s.example ? (
                        <div className="sexample">
                          <span className="jp">{s.example}</span>
                          {s.exampleTranslation ? <em>{s.exampleTranslation}</em> : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </details>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

/* ────────────────────────────── 查词结果 ────────────────────────────── */

interface LookupSectionsProps {
  state: LookupState;
  onInternalLookup: (query: string) => void;
  onAskAi: (entry: DictEntry) => void;
}

function LookupSections({ state, onInternalLookup, onAskAi }: LookupSectionsProps): JSX.Element {
  const { loading, data, error } = state;

  const extraPitch = useMemo(() => data?.pitch ?? [], [data]);

  if (loading) {
    return (
      <div className="loading-row">
        <span className="spin" /> 正在查询词典…
      </div>
    );
  }
  if (error) {
    return (
      <div className="banner error detail-banner">
        <span aria-hidden="true">✕</span>
        <span>查询词典失败：{error}</span>
      </div>
    );
  }
  if (!data) return <></>;

  return (
    <>
      {data.frequency.length > 0 ? (
        <section className="section">
          <SectionHead>频率</SectionHead>
          <div className="taglist">
            {data.frequency.map((f, i) => (
              <span className="tag tag-cat-frequency" key={i} title={f.dictTitle}>
                {f.dictTitle} {f.displayValue}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {extraPitch.length > 0 ? (
        <section className="section">
          <SectionHead>声调（词典）</SectionHead>
          {extraPitch.map((p, i) => (
            <PitchCurve key={i} pitch={p} />
          ))}
        </section>
      ) : null}

      <section className="section">
        <SectionHead count={data.entries.length > 0 ? `${data.entries.length} 条` : undefined}>词典释义</SectionHead>
        {data.entries.length > 0 ? (
          <GlossaryView entries={data.entries} onInternalLookup={onInternalLookup} onAskAi={onAskAi} />
        ) : (
          <p className="note faint">
            未在已启用的词典中找到「{data.query}」。可在「词典」中确认是否已导入并启用相关词典。
          </p>
        )}
      </section>

      {data.kanji.length > 0 ? (
        <section className="section">
          <SectionHead count={`${data.kanji.length} 字`}>汉字</SectionHead>
          <KanjiView kanji={data.kanji} />
        </section>
      ) : null}
    </>
  );
}
