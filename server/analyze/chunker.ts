/**
 * 词单位合并：把 kuromoji 的碎片词素粘成语义完整的「词单位」（Word），
 * 内部拆解保留在 subTokens 里。
 *
 * 目标是让 UI 能明确圈出「这几个假名连在一起才是一个词」，
 * 避免「て+いる」「なかっ+た」这类被拆开后产生的歧义读法。
 */
import type { FuriganaSegment, Pos, SubToken, Word } from '../../shared/types.ts';
import { buildFurigana, isKana, toHiragana } from '../../shared/kana.ts';
import type { PositionedToken } from './tokenizer.ts';
import { annotateAndInflect } from './inflection.ts';
import type { DictQuery } from './dictBridge.ts';

/* ────────────────────────────── 小工具 ────────────────────────────── */

function clean(v: string | undefined): string {
  return !v || v === '*' ? '' : v;
}

function readingOf(t: PositionedToken): string {
  const r = clean(t.reading);
  if (r) return toHiragana(r);
  // UNKNOWN 词没有读音；表层若本身是假名就直接用
  return [...t.surface_form].every((c) => isKana(c)) ? toHiragana(t.surface_form) : '';
}

function lemmaOf(t: PositionedToken): string {
  return clean(t.basic_form) || t.surface_form;
}

/** 辞書形无法从 surface 推读音时的不规则表 */
const IRREGULAR_LEMMA_READING: Record<string, string> = {
  来る: 'くる', 為る: 'する', 出来る: 'できる', 居る: 'いる', 有る: 'ある', 成る: 'なる',
};

/**
 * 由「表层 + 表层读音 + 辞書形」推出辞書形的读音。
 * 思路：表层与辞書形共享汉字词干，差异只在送り仮名，
 * 因此把表层读音末尾的送り仮名换成辞書形的送り仮名即可。
 */
function lemmaReadingOf(surface: string, reading: string, lemma: string): string {
  if (IRREGULAR_LEMMA_READING[lemma]) return IRREGULAR_LEMMA_READING[lemma];
  if (!reading) return '';
  if (surface === lemma) return reading;

  let p = 0;
  const sc = [...surface];
  const lc = [...lemma];
  while (p < sc.length && p < lc.length && sc[p] === lc[p]) p++;
  const sTail = sc.slice(p).join('');
  const lTail = lc.slice(p).join('');
  // 只有当两侧差异部分都是假名时，替换才是安全的
  if ([...sTail].every(isKana) && [...lTail].every(isKana) && reading.endsWith(toHiragana(sTail))) {
    return reading.slice(0, reading.length - toHiragana(sTail).length) + toHiragana(lTail);
  }
  return reading;
}

function toSubToken(t: PositionedToken): SubToken {
  return {
    surface: t.surface_form,
    reading: readingOf(t),
    lemma: lemmaOf(t),
    posJa: t.pos,
    posDetail: [t.pos_detail_1, t.pos_detail_2, t.pos_detail_3].map(clean).filter(Boolean),
    conjType: clean(t.conjugated_type),
    conjForm: clean(t.conjugated_form),
  };
}

/**
 * 数词＋量词的不规则读法。kuromoji 逐词素拼读会给出「ななじ」这类错误读音，
 * 对学习者而言注音错了比没有更糟，因此对高频组合做修正。
 */
const COUNTER_READING_FIX: Record<string, string> = {
  一人: 'ひとり', 二人: 'ふたり',
  一日: 'ついたち', 二日: 'ふつか', 三日: 'みっか', 四日: 'よっか', 五日: 'いつか',
  六日: 'むいか', 七日: 'なのか', 八日: 'ようか', 九日: 'ここのか', 十日: 'とおか', 二十日: 'はつか',
  四時: 'よじ', 七時: 'しちじ', 九時: 'くじ',
  一分: 'いっぷん', 三分: 'さんぷん', 四分: 'よんぷん', 六分: 'ろっぷん', 八分: 'はっぷん', 十分: 'じゅっぷん',
  一月: 'いちがつ', 四月: 'しがつ', 七月: 'しちがつ', 九月: 'くがつ',
  四年: 'よねん', 七年: 'ななねん', 九年: 'きゅうねん',
  四回: 'よんかい', 一回: 'いっかい', 六回: 'ろっかい', 八回: 'はっかい', 十回: 'じゅっかい',
  四人: 'よにん', 七人: 'ななにん',
};

/** 逐词素对齐后拼接，比整词对齐更精确 */
function buildWordFurigana(subs: SubToken[]): FuriganaSegment[] {
  const segs: FuriganaSegment[] = [];
  for (const sub of subs) {
    for (const seg of buildFurigana(sub.surface, sub.reading)) segs.push(seg);
  }
  const merged: FuriganaSegment[] = [];
  for (const seg of segs) {
    const last = merged[merged.length - 1];
    if (last && last.ruby === undefined && seg.ruby === undefined) last.text += seg.text;
    else merged.push({ ...seg });
  }
  return merged;
}

/* ────────────────────────────── 词性标签 ────────────────────────────── */

function verbLabel(conjType: string): string {
  if (conjType.startsWith('五段・')) {
    const row = conjType.slice(3).replace(/(促音便|イ音便|ウ音便|撥音便).*$/, '');
    return `动词（五段·${row}）`;
  }
  if (conjType.startsWith('一段')) return '动词（一段）';
  if (conjType.startsWith('サ変')) return '动词（サ变）';
  if (conjType.startsWith('カ変')) return '动词（カ变）';
  if (conjType.startsWith('ラ変')) return '动词（ラ变）';
  if (conjType.startsWith('四段')) return '动词（文语四段）';
  if (conjType.startsWith('下二') || conjType.startsWith('上二')) return '动词（文语二段）';
  return '动词';
}

const PARTICLE_CAT_LABEL_JA: Record<string, string> = {
  格助詞: '格助词',
  係助詞: '系助词',
  副助詞: '副助词',
  接続助詞: '接续助词',
  並立助詞: '并立助词',
  終助詞: '终助词',
  '副助詞／並立助詞／終助詞': '副助词',
  連体化: '连体化',
  副詞化: '副词化',
  特殊: '特殊',
  間投助詞: '间投助词',
};

function posOf(t: PositionedToken): { pos: Pos; label: string } {
  const d1 = clean(t.pos_detail_1);
  const d2 = clean(t.pos_detail_2);
  switch (t.pos) {
    case '名詞':
      if (d1 === '代名詞') return { pos: 'pronoun', label: '代词' };
      if (d1 === '固有名詞') {
        if (d2 === '人名') return { pos: 'propernoun', label: '专有名词（人名）' };
        if (d2 === '地域') return { pos: 'propernoun', label: '专有名词（地名）' };
        if (d2 === '組織') return { pos: 'propernoun', label: '专有名词（组织）' };
        return { pos: 'propernoun', label: '专有名词' };
      }
      if (d1 === '数') return { pos: 'number', label: '数词' };
      if (d1 === '形容動詞語幹') return { pos: 'na-adjective', label: 'な形容词' };
      if (d1 === 'ナイ形容詞語幹') return { pos: 'i-adjective', label: 'い形容词（词干）' };
      if (d1 === '接尾') {
        if (d2 === '助数詞') return { pos: 'counter', label: '量词' };
        if (d2 === '人名') return { pos: 'suffix', label: '接尾词（敬称）' };
        return { pos: 'suffix', label: '接尾词' };
      }
      if (d1 === 'サ変接続') return { pos: 'noun', label: '名词（サ变）' };
      if (d1 === '副詞可能') return { pos: 'noun', label: '名词（可作副词）' };
      if (d1 === '非自立') return { pos: 'noun', label: '形式名词' };
      if (d1 === '動詞非自立的') return { pos: 'verb', label: '动词（补助）' };
      return { pos: 'noun', label: '名词' };
    case '動詞':
      if (d1 === '接尾') return { pos: 'auxiliary', label: '助动词（动词性接尾）' };
      return { pos: 'verb', label: verbLabel(clean(t.conjugated_type)) };
    case '形容詞':
      return { pos: 'i-adjective', label: 'い形容词' };
    case '副詞':
      return { pos: 'adverb', label: '副词' };
    case '連体詞':
      return { pos: 'prenominal', label: '连体词' };
    case '接続詞':
      return { pos: 'conjunction', label: '接续词' };
    case '感動詞':
      return { pos: 'interjection', label: '感叹词' };
    case 'フィラー':
      return { pos: 'interjection', label: '感叹词（填充语）' };
    case '助詞':
      return { pos: 'particle', label: `助词（${PARTICLE_CAT_LABEL_JA[d1] ?? '助词'}）` };
    case '助動詞':
      return { pos: 'auxiliary', label: '助动词' };
    case '接頭詞':
      return { pos: 'prefix', label: '接头词' };
    case '記号':
      if (d1 === '空白') return { pos: 'whitespace', label: '空白' };
      return { pos: 'symbol', label: '符号' };
    default:
      return { pos: 'other', label: '其他' };
  }
}

/* ────────────────────────────── 合并判定 ────────────────────────────── */

const SURU_LEMMAS = new Set(['する', 'できる', 'なさる', '致す', 'いたす']);
const COPULA_LEMMAS = new Set(['だ', 'です', 'ます']);

function isNounish(t: PositionedToken): boolean {
  return (
    t.pos === '名詞' &&
    ['一般', '固有名詞', 'サ変接続', '形容動詞語幹', '副詞可能'].includes(clean(t.pos_detail_1))
  );
}

/** 名詞非自立「の／ん」实际充当准体助词，单独成词并按助词处理 */
function isNominalizerNo(t: PositionedToken): boolean {
  return (
    t.pos === '名詞' &&
    clean(t.pos_detail_1) === '非自立' &&
    (t.surface_form === 'の' || t.surface_form === 'ん')
  );
}

function isTeParticle(t: PositionedToken): boolean {
  return (
    t.pos === '助詞' &&
    clean(t.pos_detail_1) === '接続助詞' &&
    (t.surface_form === 'て' || t.surface_form === 'で')
  );
}

/** 谓语（动词/形容词/助动词）可以吸收的后续附属成分 */
function canAbsorbToPredicate(t: PositionedToken): boolean {
  const d1 = clean(t.pos_detail_1);
  if (t.pos === '助動詞') return true;
  if (t.pos === '動詞' && (d1 === '接尾' || d1 === '非自立')) return true;
  if (t.pos === '形容詞' && d1 === '非自立') return true;
  if (isTeParticle(t)) return true;
  if (t.pos === '名詞' && d1 === '接尾' && clean(t.pos_detail_2) !== '助数詞') return true;
  // 様態の「そう」：名詞,特殊,助動詞語幹
  if (t.pos === '名詞' && d1 === '特殊' && clean(t.pos_detail_2) === '助動詞語幹') return true;
  return false;
}

/** 体言可以吸收的后续成分：只限断定助动词链与接尾词 */
function canAbsorbToNoun(t: PositionedToken): boolean {
  if (t.pos === '助動詞') return true;
  const d1 = clean(t.pos_detail_1);
  if (t.pos === '名詞' && d1 === '接尾' && clean(t.pos_detail_2) !== '助数詞') return true;
  return false;
}

/* ────────────────────────────── 复合名词候选 ────────────────────────────── */

/** 复合名词最多合并几个词素 */
const MAX_COMPOUND = 3;

/**
 * 收集「连续名词」构成的复合词候选，交给上层批量查词典校验。
 * 只有词典确实收录的串才会被合并（保守策略，避免造出不存在的词）。
 */
export function collectCompoundCandidates(tokens: PositionedToken[]): DictQuery[] {
  const out: DictQuery[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isNounish(tokens[i])) continue;
    let term = tokens[i].surface_form;
    for (let n = 1; n < MAX_COMPOUND && i + n < tokens.length; n++) {
      const next = tokens[i + n];
      if (!isNounish(next)) break;
      term += next.surface_form;
      out.push({ term });
    }
  }
  return out;
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

export interface ChunkOptions {
  sentenceIndex: number;
  /** 经词典校验存在的复合名词表层串 */
  acceptedCompounds: Set<string>;
}

interface Unit {
  tokens: PositionedToken[];
  /** 词干占前几个 token（含接头词），附属成分链从这里开始 */
  headCount: number;
  /** 决定词性的 token 在 tokens 中的下标 */
  headIdx: number;
  /** 覆盖词性 */
  overridePos?: Pos;
  overrideLabel?: string;
  inflectable: boolean;
}

function makeWord(unit: Unit, opts: ChunkOptions): Word {
  const { tokens, headCount, headIdx } = unit;
  const subTokens = tokens.map(toSubToken);
  const headToken = tokens[headIdx];
  const surface = tokens.map((t) => t.surface_form).join('');

  // 数量词读音修正（七時 → しちじ，而非逐字拼出的ななじ）
  const fixed = COUNTER_READING_FIX[surface];
  let wholeRuby: string | undefined;
  if (fixed) {
    const tailReading = subTokens[subTokens.length - 1]?.reading ?? '';
    if (subTokens.length === 2 && tailReading && fixed.endsWith(tailReading) && fixed.length > tailReading.length) {
      subTokens[0].reading = fixed.slice(0, fixed.length - tailReading.length);
    } else {
      wholeRuby = fixed; // 无法拆分（ついたち等熟字训），整体注一个音
    }
  }
  const reading = fixed ?? subTokens.map((s) => s.reading).join('');

  // 词干辞書形 = 词干前 n-1 个词素的表层 + 最后一个词素的辞書形
  // （お+弁当→お弁当、勉強+し→勉強する、七+時→七時）
  const baseLemma =
    tokens.slice(0, headCount - 1).map((t) => t.surface_form).join('') + lemmaOf(tokens[headCount - 1]);

  const detected = posOf(headToken);
  const pos = unit.overridePos ?? detected.pos;
  const label = unit.overrideLabel ?? detected.label;

  const inflection = annotateAndInflect({
    subTokens,
    headCount,
    baseLemma,
    inflectable: unit.inflectable,
  });

  // 词干读音：合并单位时把词干部分的读音拼起来再换送り仮名
  const headSurface = tokens.slice(0, headCount).map((t) => t.surface_form).join('');
  const headReading = subTokens.slice(0, headCount).map((s) => s.reading).join('');
  const lemmaReading = lemmaReadingOf(headSurface, headReading, baseLemma);

  return {
    id: -1,
    sentenceIndex: opts.sentenceIndex,
    start: tokens[0].start,
    end: tokens[tokens.length - 1].end,
    surface,
    reading,
    furigana: wholeRuby ? buildFurigana(surface, wholeRuby) : buildWordFurigana(subTokens),
    lemma: baseLemma,
    lemmaReading,
    pos,
    posLabel: label,
    posJa: headToken.pos,
    isParticle: pos === 'particle',
    subTokens,
    inflection,
    brief: [],
    hasMore: false,
    pitch: [],
    frequency: [],
    unknown: true,
  };
}

/**
 * 把一句话的 token 流切成词单位。
 */
export function chunk(tokens: PositionedToken[], opts: ChunkOptions): Word[] {
  const words: Word[] = [];
  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i];

    /* 符号 */
    if (t.pos === '記号') {
      words.push(makeWord({ tokens: [t], headCount: 1, headIdx: 0, inflectable: false }, opts));
      i++;
      continue;
    }

    /* 助词单独成词（て/で 已在谓语分支被吸收，走到这里说明它是独立的） */
    if (t.pos === '助詞') {
      words.push(makeWord({ tokens: [t], headCount: 1, headIdx: 0, inflectable: false }, opts));
      i++;
      continue;
    }

    /* 准体助词「の」：kuromoji 标成名詞非自立，但语法上按助词处理 */
    if (isNominalizerNo(t)) {
      words.push(
        makeWord(
          {
            tokens: [t],
            headCount: 1,
            headIdx: 0,
            inflectable: false,
            overridePos: 'particle',
            overrideLabel: '助词（准体助词）',
          },
          opts,
        ),
      );
      i++;
      continue;
    }

    const group: PositionedToken[] = [];
    let headIdx = 0;
    let overridePos: Pos | undefined;
    let overrideLabel: string | undefined;

    /* 接頭詞 + 自立语 → お茶、ご飯 */
    const next = tokens[i + 1];
    if (t.pos === '接頭詞' && next && ['名詞', '動詞', '形容詞'].includes(next.pos)) {
      group.push(t);
      i++;
      headIdx = 1;
    }

    const head = tokens[i];
    if (!head) break;
    group.push(head);
    i++;

    let kind: 'predicate' | 'noun' | 'other' =
      head.pos === '動詞' || head.pos === '形容詞' || head.pos === '助動詞'
        ? 'predicate'
        : head.pos === '名詞'
          ? 'noun'
          : 'other';

    if (kind === 'noun') {
      if (clean(head.pos_detail_1) === '数') {
        /* 连续数词 + 助数詞 → 数量词 */
        while (i < tokens.length && tokens[i].pos === '名詞' && clean(tokens[i].pos_detail_1) === '数') {
          group.push(tokens[i]);
          i++;
        }
        if (
          i < tokens.length &&
          tokens[i].pos === '名詞' &&
          clean(tokens[i].pos_detail_1) === '接尾' &&
          clean(tokens[i].pos_detail_2) === '助数詞'
        ) {
          group.push(tokens[i]);
          i++;
          overridePos = 'counter';
          overrideLabel = '数量词（数词＋量词）';
        }
      } else if (isNounish(head)) {
        /* 复合名词：保守合并——只在词典确认整串存在时合并，取最长匹配 */
        let best = 0;
        let term = head.surface_form;
        for (let n = 1; n < MAX_COMPOUND && i + n - 1 < tokens.length; n++) {
          const cand = tokens[i + n - 1];
          if (!isNounish(cand)) break;
          term += cand.surface_form;
          if (opts.acceptedCompounds.has(term)) best = n;
        }
        for (let n = 0; n < best; n++) {
          group.push(tokens[i]);
          i++;
        }
      }

      /* サ変：名詞（サ変接続） + する/できる → 合并为一个动词单位 */
      const suru = tokens[i];
      const stemTail = group[group.length - 1];
      if (
        suru &&
        suru.pos === '動詞' &&
        clean(suru.pos_detail_1) === '自立' &&
        SURU_LEMMAS.has(lemmaOf(suru)) &&
        clean(stemTail.pos_detail_1) === 'サ変接続'
      ) {
        group.push(suru);
        i++;
        headIdx = group.length - 1; // 由「する」决定活用类型
        kind = 'predicate';
      }
    }

    /* 至此词干完成，下面开始吸收附属成分 */
    const headCount = group.length;

    if (kind === 'predicate') {
      while (i < tokens.length && canAbsorbToPredicate(tokens[i])) {
        group.push(tokens[i]);
        i++;
      }
    } else if (kind === 'noun') {
      while (i < tokens.length && canAbsorbToNoun(tokens[i])) {
        group.push(tokens[i]);
        i++;
      }
      // 体言 + 断定助动词 → 断定形；な形容词词干 + だ/な 仍算な形容词
      const tail = group[group.length - 1];
      if (group.length > headCount && tail.pos === '助動詞' && COPULA_LEMMAS.has(lemmaOf(tail))) {
        const base = posOf(head);
        if (base.pos !== 'na-adjective' && !overrideLabel) {
          overridePos = base.pos;
          overrideLabel = `${base.label}＋断定`;
        }
      }
    }

    // 只有谓语、な形容词、以及带断定助动词的体言才需要还原链
    const inflectable =
      kind === 'predicate' ||
      posOf(head).pos === 'na-adjective' ||
      (group.length > headCount && group[group.length - 1].pos === '助動詞');

    words.push(
      makeWord({ tokens: group, headCount, headIdx, overridePos, overrideLabel, inflectable }, opts),
    );
  }

  return words;
}
