/**
 * 声调曲线：按拍画高低线，末尾虚线圆点代表后续助词的高低。
 * 线条走细、走精致，配合整站的复古衬线风格。
 */
import { splitMora } from '@shared/kana';
import type { PitchAccent } from '@shared/types';

interface Props {
  pitch: PitchAccent;
}

/**
 * 东京式规则：
 * - 0（平板）：第 1 拍低，其后全高，后续助词也高
 * - 1（頭高）：第 1 拍高，其后全低
 * - n≥2（中高/尾高）：第 1 拍低，第 2..n 拍高，n+1 之后低
 */
function isHigh(moraIndex1Based: number, position: number): boolean {
  if (position === 0) return moraIndex1Based > 1;
  if (position === 1) return moraIndex1Based === 1;
  return moraIndex1Based > 1 && moraIndex1Based <= position;
}

const STEP = 20;
const PAD = 11;
const TOP = 9;
const BOTTOM = 25;
const HEIGHT = 50;

export function PitchCurve({ pitch }: Props): JSX.Element | null {
  const mora = splitMora(pitch.reading || '');
  if (mora.length === 0) return null;

  const position = Number.isFinite(pitch.position) ? Math.max(0, Math.trunc(pitch.position)) : 0;
  const points = mora.map((m, i) => ({
    x: PAD + i * STEP,
    y: isHigh(i + 1, position) ? TOP : BOTTOM,
    text: m,
    tail: false,
  }));
  // 后续助词：只有平板型才继续保持高
  points.push({
    x: PAD + mora.length * STEP,
    y: position === 0 ? TOP : BOTTOM,
    text: '＋',
    tail: true,
  });

  const width = PAD * 2 + mora.length * STEP;
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
  // 下降处画一条竖向细虚线，视觉上标出「核」
  const drop = position > 0 && position < mora.length ? PAD + (position - 0.5) * STEP : null;

  return (
    <div className="pitch-block">
      <div className="pitch-meta">
        <span className="pattern">{pitch.patternLabel || (position === 0 ? '平板型' : `${position}型`)}</span>
        <span className="core">
          核 <b>{position}</b>
        </span>
        <span className="faint src">{pitch.dictTitle}</span>
      </div>
      <svg
        className="pitch-svg"
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label={`${pitch.reading} ${pitch.patternLabel} 第${position}拍后下降`}
      >
        <line className="pbase" x1="0" y1={TOP} x2={width} y2={TOP} />
        <line className="pbase" x1="0" y1={BOTTOM} x2={width} y2={BOTTOM} />
        {drop != null ? <line className="pdrop" x1={drop} y1={TOP - 4} x2={drop} y2={BOTTOM + 4} /> : null}
        <path className="pline" d={path} />
        {points.map((p, i) => (
          <circle key={i} className={p.tail ? 'pdot tail' : 'pdot'} cx={p.x} cy={p.y} r={2.8} />
        ))}
        {points.map((p, i) => (
          <text key={`t${i}`} className={p.tail ? 'pmora tail' : 'pmora'} x={p.x} y={HEIGHT - 5}>
            {p.text}
          </text>
        ))}
      </svg>
    </div>
  );
}
