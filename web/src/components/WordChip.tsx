/**
 * 词单位 chip —— 阅读区里数量最多的组件（长文可达数千个）。
 *
 * 性能约束：
 * - 纯展示，**不挂任何事件处理器**（点击/悬停由 ReadingView 事件委托统一处理）
 * - React.memo + 稳定的 props，hover 完全交给 CSS
 */
import { memo } from 'react';
import type { FuriganaSegment, Word } from '@shared/types';
import type { FuriganaMode } from '../state';

/** 频率排名小于该值视为「熟词」，「仅汉字生词」模式下不注音 */
const COMMON_RANK = 3000;

export function shouldShowFurigana(word: Word, mode: FuriganaMode): boolean {
  if (mode === 'off') return false;
  if (!(word.furigana ?? []).some((s) => s.ruby)) return false;
  if (mode === 'all') return true;
  if (word.unknown) return true;
  const freq = word.frequency ?? [];
  if (freq.length === 0) return true;
  // 假定 value 越小越常用（rank-based）；occurrence-based 词典会被当成生词，宁可多注音
  const best = Math.min(...freq.map((f) => (Number.isFinite(f.value) ? f.value : Infinity)));
  return !(best > 0 && best <= COMMON_RANK);
}

/**
 * 把 furigana 分段按 subToken 边界切成若干「部件」，用于在下划线上画细分刻度。
 * 跨越汉字注音块的边界无法切分（会破坏 ruby 对齐），直接忽略。
 */
function buildParts(word: Word): FuriganaSegment[][] {
  const segments = word.furigana?.length ? word.furigana : [{ text: word.surface }];
  const subTokens = word.subTokens ?? [];
  if (subTokens.length < 2) return [segments];

  const total = [...word.surface].length;
  const cuts = new Set<number>();
  let acc = 0;
  for (const st of subTokens) {
    acc += [...st.surface].length;
    if (acc < total) cuts.add(acc);
  }
  // subTokens 拼不出表层形（服务端合并策略变化时可能发生）：不做切分
  if (acc !== total || cuts.size === 0) return [segments];

  const groups: FuriganaSegment[][] = [];
  let current: FuriganaSegment[] = [];
  let offset = 0;

  for (const seg of segments) {
    const chars = [...seg.text];
    if (seg.ruby) {
      current.push(seg);
      offset += chars.length;
      if (cuts.has(offset)) {
        groups.push(current);
        current = [];
      }
      continue;
    }
    let buf = '';
    for (const ch of chars) {
      buf += ch;
      offset += 1;
      if (cuts.has(offset)) {
        current.push({ text: buf });
        buf = '';
        groups.push(current);
        current = [];
      }
    }
    if (buf) current.push({ text: buf });
  }
  if (current.length) groups.push(current);
  return groups.length ? groups : [segments];
}

function renderSegment(seg: FuriganaSegment, key: number, ruby: boolean): JSX.Element {
  if (ruby && seg.ruby) {
    return (
      <ruby key={key}>
        {seg.text}
        <rp>（</rp>
        <rt>{seg.ruby}</rt>
        <rp>）</rp>
      </ruby>
    );
  }
  return <span key={key}>{seg.text}</span>;
}

export interface WordChipProps {
  word: Word;
  furigana: FuriganaMode;
  selected: boolean;
}

function WordChipImpl({ word, furigana, selected }: WordChipProps): JSX.Element {
  const plain = word.pos === 'symbol' || word.pos === 'whitespace';
  const ruby = shouldShowFurigana(word, furigana);
  const parts = buildParts(word);
  const romaji = word.particle?.romaji;

  const cls = [
    'word',
    `pos-${word.pos}`,
    word.isParticle ? 'is-particle' : '',
    word.unknown && !plain && !word.isParticle ? 'is-unknown' : '',
    parts.length > 1 ? 'is-multi' : '',
    plain ? 'is-plain' : '',
    selected ? 'is-selected' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={cls}
      data-word-id={word.id}
      tabIndex={plain ? -1 : 0}
      role={plain ? undefined : 'button'}
      aria-label={plain ? undefined : `${word.surface}，${word.reading}，${word.posLabel}`}
    >
      {romaji ? <span className="romaji">{romaji}</span> : null}
      {parts.map((segs, i) => (
        <span className="part" key={i}>
          {segs.map((seg, j) => renderSegment(seg, j, ruby))}
        </span>
      ))}
    </span>
  );
}

export const WordChip = memo(WordChipImpl);
