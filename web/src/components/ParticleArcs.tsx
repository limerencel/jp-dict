/**
 * 助词关系图：在句子下方用 SVG 弧线连接助词与其前接/后接成分。
 *
 * 位置全部来自 DOM 实测（chip 由 ReadingView 渲染，这里只读 getBoundingClientRect），
 * 因此换行、字号、主题变化都能自适应；ResizeObserver + 字体就绪时重算。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Word } from '@shared/types';

interface Arc {
  d: string;
  color: string;
  label: string;
  lx: number;
  ly: number;
  showLabel: boolean;
}

interface Props {
  /** 句子容器（position: relative），弧线坐标相对于它 */
  containerRef: RefObject<HTMLElement>;
  words: Word[];
  /** 依赖变化时强制重算（例如振假名开关） */
  revision: unknown;
}

/* 前接成分用藍鼠，后接成分用朱：暖色底上两条弧线仍能一眼分开 */
const BEFORE_COLOR = 'var(--accent-2)';
const AFTER_COLOR = 'var(--accent)';

/** 与 styles.css 里 `.arc-label` 的 font-size 保持一致，用于估算标注宽度 */
const ARC_LABEL_SIZE = 11;

export function ParticleArcs({ containerRef, words, revision }: Props): JSX.Element | null {
  const [arcs, setArcs] = useState<Arc[]>([]);
  const [extra, setExtra] = useState(0);
  // 撑高用的占位块本身会计入容器高度，度量时必须扣掉，否则会来回震荡
  const extraRef = useRef(0);
  const frame = useRef(0);

  const measure = useCallback(() => {
    const root = containerRef.current;
    if (!root) return;
    const base = root.getBoundingClientRect();
    if (base.width === 0) return;

    const geom = (id: number): { cx: number; bottom: number } | null => {
      const el = root.querySelector<HTMLElement>(`[data-word-id="${id}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { cx: r.left - base.left + r.width / 2, bottom: r.bottom - base.top };
    };

    const next: Arc[] = [];
    let maxY = 0;

    for (const w of words) {
      const p = w.particle;
      if (!p) continue;
      const pg = geom(w.id);
      if (!pg) continue;

      for (const [arg, color] of [
        [p.before, BEFORE_COLOR] as const,
        [p.after, AFTER_COLOR] as const,
      ]) {
        if (!arg) continue;
        const ag = geom(arg.wordId);
        if (!ag) continue;

        const x1 = ag.cx;
        const y1 = ag.bottom + 2;
        const x2 = pg.cx;
        const y2 = pg.bottom + 2;
        const dx = Math.abs(x2 - x1);
        if (dx < 2) continue;
        // 跨度越大弧越深，天然形成嵌套层次，避免叠在一起
        const depth = Math.min(56, Math.max(15, dx * 0.21)) + Math.abs(y2 - y1) * 0.12;
        const ymax = Math.max(y1, y2) + depth;
        maxY = Math.max(maxY, ymax);

        // 能否放下标注取决于文字实际有多宽，而不是一个固定跨度阈值：
        // 用固定阈值会让「主题」这种两字标注在中等跨度的弧上被无谓地丢掉。
        const label = arg.role || '';
        const labelWidth = [...label].length * ARC_LABEL_SIZE * 1.02;

        next.push({
          d: `M${x1.toFixed(1)} ${y1.toFixed(1)} C${x1.toFixed(1)} ${ymax.toFixed(1)}, ${x2.toFixed(1)} ${ymax.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`,
          color,
          label,
          lx: (x1 + x2) / 2,
          ly: (y1 + y2 + 6 * ymax) / 8 + 3.5,
          showLabel: Boolean(label) && dx >= labelWidth + 10,
        });
      }
    }

    setArcs(next);

    const natural = base.height - extraRef.current;
    const need = next.length ? Math.max(0, Math.ceil(maxY - natural) + 16) : 0;
    if (Math.abs(need - extraRef.current) > 1) {
      extraRef.current = need;
      setExtra(need);
    }
  }, [containerRef, words]);

  const schedule = useCallback(() => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      measure();
    });
  }, [measure]);

  useLayoutEffect(() => {
    schedule();
  }, [schedule, revision]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const ro = new ResizeObserver(schedule);
    ro.observe(root);
    window.addEventListener('resize', schedule);
    // 明朝体加载完成后度量会变化
    if (document.fonts?.ready) void document.fonts.ready.then(schedule).catch(() => undefined);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      if (frame.current) cancelAnimationFrame(frame.current);
      extraRef.current = 0;
    };
  }, [containerRef, schedule]);

  if (arcs.length === 0) return null;

  return (
    <>
      <svg className="arc-layer" aria-hidden="true">
        {arcs.map((a, i) => (
          <path
            key={i}
            className="arc-path"
            d={a.d}
            stroke={a.color}
            strokeWidth={1.6}
            strokeOpacity={0.92}
            strokeDasharray={a.color === BEFORE_COLOR ? undefined : '5 3'}
          >
            {/* 弧太短放不下标注时，至少能悬停看到关系名 */}
            {a.label && !a.showLabel ? <title>{a.label}</title> : null}
          </path>
        ))}
        {arcs.map((a, i) =>
          a.showLabel ? (
            <text
              key={`l${i}`}
              className="arc-label"
              x={a.lx}
              y={a.ly}
              fill={a.color}
              stroke="var(--bg)"
              strokeOpacity={0.95}
            >
              {a.label}
            </text>
          ) : null,
        )}
      </svg>
      <div style={{ height: extra }} aria-hidden="true" />
    </>
  );
}
