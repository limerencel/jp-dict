/**
 * 悬停小面板。
 *
 * 用事件委托监听整个阅读区，chip 自身不带 handler；状态只存在于本组件，
 * 因此 hover 不会引起阅读区（数千个 chip）重渲染。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Word } from '@shared/types';

const OPEN_DELAY = 200;
const CLOSE_DELAY = 130;
const GAP = 10;
const MARGIN = 8;

interface Target {
  word: Word;
  rect: DOMRect;
}

interface Props {
  containerRef: RefObject<HTMLElement>;
  byId: Map<number, Word>;
  /** 结果变化时立即收起 */
  revision: unknown;
}

export function WordTooltip({ containerRef, byId, revision }: Props): JSX.Element | null {
  const [target, setTarget] = useState<Target | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef(0);
  const closeTimer = useRef(0);
  const overTip = useRef(false);
  /** 已排期但尚未弹出的 chip，避免鼠标在同一个词内部移动时反复重置延时 */
  const pendingId = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimer.current) window.clearTimeout(openTimer.current);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    openTimer.current = 0;
    closeTimer.current = 0;
    pendingId.current = null;
  }, []);

  const hideSoon = useCallback(() => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      if (!overTip.current) {
        setTarget(null);
        setPos(null);
      }
    }, CLOSE_DELAY);
  }, []);

  useEffect(() => {
    setTarget(null);
    setPos(null);
  }, [revision]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const chipOf = (node: EventTarget | null): HTMLElement | null => {
      if (!(node instanceof Element)) return null;
      const el = node.closest<HTMLElement>('[data-word-id]');
      return el && root.contains(el) ? el : null;
    };

    const onOver = (ev: MouseEvent): void => {
      const el = chipOf(ev.target);
      if (!el) return;
      const id = Number(el.dataset.wordId);
      const word = byId.get(id);
      if (!word || word.pos === 'symbol' || word.pos === 'whitespace') return;
      if (target && target.word.id === id) {
        if (closeTimer.current) window.clearTimeout(closeTimer.current);
        return;
      }
      if (pendingId.current === id && openTimer.current) return;
      clearTimers();
      pendingId.current = id;
      openTimer.current = window.setTimeout(() => {
        openTimer.current = 0;
        pendingId.current = null;
        setTarget({ word, rect: el.getBoundingClientRect() });
      }, OPEN_DELAY);
    };

    const onOut = (ev: MouseEvent): void => {
      const from = chipOf(ev.target);
      if (!from) return;
      const to = chipOf(ev.relatedTarget);
      if (to === from) return;
      if (openTimer.current) window.clearTimeout(openTimer.current);
      openTimer.current = 0;
      pendingId.current = null;
      hideSoon();
    };

    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseout', onOut);
    return () => {
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseout', onOut);
      clearTimers();
    };
  }, [byId, containerRef, clearTimers, hideSoon, target]);

  // 滚动时直接收起，避免跟随抖动
  useEffect(() => {
    if (!target) return;
    const close = (): void => {
      setTarget(null);
      setPos(null);
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('wheel', close, { passive: true });
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('wheel', close);
    };
  }, [target]);

  // 智能避让视口边缘
  useLayoutEffect(() => {
    if (!target || !tipRef.current) return;
    const tip = tipRef.current.getBoundingClientRect();
    const { rect } = target;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = rect.left + rect.width / 2 - tip.width / 2;
    left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, vw - tip.width - MARGIN));

    let top = rect.top - tip.height - GAP;
    if (top < MARGIN) {
      const below = rect.bottom + GAP;
      top = below + tip.height + MARGIN <= vh ? below : Math.max(MARGIN, vh - tip.height - MARGIN);
    }
    setPos({ left: Math.round(left), top: Math.round(top) });
  }, [target]);

  if (!target) return null;
  const w = target.word;
  const p = w.particle;
  const pitch = w.pitch.length > 0 ? w.pitch[0] : null;

  return (
    <div
      ref={tipRef}
      className="tooltip"
      role="tooltip"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
      onMouseEnter={() => {
        overTip.current = true;
        if (closeTimer.current) window.clearTimeout(closeTimer.current);
      }}
      onMouseLeave={() => {
        overTip.current = false;
        hideSoon();
      }}
    >
      <div className="tip-head">
        <span className="tip-surface">{w.surface}</span>
        {w.reading && w.reading !== w.surface ? <span className="tip-reading">{w.reading}</span> : null}
        <span className="chiptag">{w.posLabel}</span>
      </div>

      {p ? (
        <>
          <div className="tip-row">
            <b style={{ color: 'var(--particle)' }}>{p.sense.label}</b>
            <span className="faint">{p.categoryLabel}</span>
          </div>
          <div className="tip-row" style={{ display: 'block' }}>
            {p.sense.detail}
          </div>
          {p.structureNote ? (
            <div className="tip-sense">
              <div className="tip-row jp" style={{ display: 'block' }}>
                {p.structureNote}
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <>
          {w.lemma && w.lemma !== w.surface ? (
            <div className="tip-row">
              <span className="faint">辞書形</span>
              <span className="jp">{w.lemma}</span>
              {w.lemmaReading && w.lemmaReading !== w.lemma ? (
                <span className="faint jp">{w.lemmaReading}</span>
              ) : null}
            </div>
          ) : null}
          {w.inflection ? (
            <div className="tip-row">
              <span className="faint">形态</span>
              <span>{w.inflection.form}</span>
            </div>
          ) : null}
          {pitch ? (
            <div className="tip-row">
              <span className="faint">声调</span>
              <span style={{ color: 'var(--particle)' }}>
                {pitch.patternLabel} · 核 {pitch.position}
              </span>
            </div>
          ) : null}
          {w.brief.length > 0 ? (
            <div className="tip-sense">
              {w.brief.slice(0, 3).map((b, i) => (
                <div className="tip-sense-item" key={i}>
                  <span className="tip-dict" title={b.dictTitle}>
                    {b.dictTitle}
                  </span>
                  <span>{b.text}</span>
                </div>
              ))}
            </div>
          ) : w.unknown ? (
            <div className="tip-sense faint">未在已启用的词典中找到</div>
          ) : null}
        </>
      )}

      <div className="tip-hint">点击查看完整解析{w.hasMore ? ' · 还有更多释义' : ''}</div>
    </div>
  );
}
