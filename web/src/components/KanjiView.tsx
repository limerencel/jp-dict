/**
 * 汉字卡片：做成方正的「字典字头」——左侧一个大字，右侧音读/训读分列 + 字义。
 * 排版参照纸质辞典的汉字栏：细直线分隔，无圆角。
 */
import type { KanjiEntry } from '@shared/types';
import { Tag } from './GlossaryView';

const STAT_LABEL: Record<string, string> = {
  strokes: '笔画',
  grade: '学年',
  jlpt: 'JLPT',
  freq: '频度',
  frequency: '频度',
  heisig: 'Heisig',
  skip: 'SKIP',
  radical: '部首',
};

/** 优先展示的统计项，其余按原顺序跟在后面 */
const STAT_ORDER = ['strokes', 'radical', 'grade', 'jlpt', 'freq', 'frequency'];

function sortStats(stats: Record<string, string>): [string, string][] {
  const entries = Object.entries(stats ?? {});
  return entries.sort((a, b) => {
    const ia = STAT_ORDER.indexOf(a[0]);
    const ib = STAT_ORDER.indexOf(b[0]);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

export function KanjiView({ kanji }: { kanji: KanjiEntry[] }): JSX.Element {
  return (
    <div className="kanji-grid">
      {kanji.map((k, i) => {
        const stats = sortStats(k.stats);
        return (
          <article className="kanji-card" key={`${k.character}-${k.dictId}-${i}`}>
            <div className="kanji-char jp" lang="ja">
              {k.character}
            </div>
            <div className="kanji-info">
              {k.onyomi.length > 0 ? (
                <div className="krow">
                  <span className="k">音</span>
                  <span className="v jp">{k.onyomi.join('・')}</span>
                </div>
              ) : null}
              {k.kunyomi.length > 0 ? (
                <div className="krow">
                  <span className="k">訓</span>
                  <span className="v jp">{k.kunyomi.join('・')}</span>
                </div>
              ) : null}
              {k.meanings.length > 0 ? (
                <div className="krow">
                  <span className="k">義</span>
                  <span className="v meanings">{k.meanings.join('；')}</span>
                </div>
              ) : null}
              {k.tags.length > 0 ? (
                <div className="taglist gap-t">
                  {k.tags.map((t, ti) => (
                    <Tag key={ti} tag={t} />
                  ))}
                </div>
              ) : null}
              {stats.length > 0 ? (
                <div className="kanji-stats">
                  {stats.map(([key, value]) => (
                    <span className="kstat" key={key}>
                      <span className="kstat-k">{STAT_LABEL[key] ?? key}</span>
                      <span className="kstat-v">{value}</span>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="kanji-src faint">{k.dictTitle}</div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
