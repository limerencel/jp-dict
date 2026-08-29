/**
 * 分析引擎入口：分句 → 分词 → 词单位合并 → 活用还原 → 助词判定 → 批量查词典。
 */
import type { AnalysisResult, BriefSense, DictEntry, Sentence, SubToken, Word } from '../../shared/types.ts';
import { glossaryToText } from '../../shared/glossary.ts';
import { MAX_TEXT_LENGTH } from '../config.ts';
import { getTokenizer, splitSentences, tokenizeWithOffsets } from './tokenizer.ts';
import { chunk, collectCompoundCandidates } from './chunker.ts';
import { annotateParticles } from './particles.ts';
import {
  initDict,
  listDictionaries,
  lookupExtras,
  lookupTermsBatch,
  queryKey,
  type DictQuery,
} from './dictBridge.ts';

/** hover 释义最多显示几条 */
const BRIEF_LIMIT = 3;
/** 单条释义截断长度 */
const BRIEF_TEXT_LEN = 60;

/* ────────────────────────────── 空隙补齐 ────────────────────────────── */

function gapSubToken(surface: string, posJa: string): SubToken {
  return { surface, reading: '', lemma: surface, posJa, posDetail: [], conjType: '', conjForm: '' };
}

/** kuromoji 会吞掉空白等字符，这里把原文里没被任何 token 覆盖的片段补成 Word，保证偏移连续 */
function makeGapWord(text: string, start: number, end: number, sentenceIndex: number): Word {
  const surface = text.slice(start, end);
  const blank = /^\s+$/.test(surface);
  return {
    id: -1,
    sentenceIndex,
    start,
    end,
    surface,
    reading: '',
    furigana: [{ text: surface }],
    lemma: surface,
    lemmaReading: '',
    pos: blank ? 'whitespace' : 'symbol',
    posLabel: blank ? '空白' : '符号',
    posJa: blank ? '空白' : '記号',
    isParticle: false,
    subTokens: [gapSubToken(surface, blank ? '空白' : '記号')],
    brief: [],
    hasMore: false,
    pitch: [],
    frequency: [],
    unknown: false,
  };
}

/* ────────────────────────────── 查词候选 ────────────────────────────── */

/**
 * 一个词单位的查词候选，按可信度排序：
 * 辞書形＋读音 → 辞書形 → 表层＋读音 → 表层 → 辞書形的假名形。
 */
function candidatesFor(w: Word): DictQuery[] {
  const out: DictQuery[] = [];
  const push = (term: string, reading?: string): void => {
    if (!term) return;
    if (out.some((q) => q.term === term && q.reading === reading)) return;
    out.push(reading ? { term, reading } : { term });
  };
  push(w.lemma, w.lemmaReading || undefined);
  push(w.lemma);
  if (w.surface !== w.lemma) {
    push(w.surface, w.reading || undefined);
    push(w.surface);
  }
  if (w.lemmaReading && w.lemmaReading !== w.lemma) push(w.lemmaReading);
  return out;
}

function isLexical(w: Word): boolean {
  return w.pos !== 'whitespace' && w.pos !== 'symbol';
}

function toBrief(entry: DictEntry): BriefSense {
  return {
    dictTitle: entry.dictTitle,
    term: entry.term,
    reading: entry.reading,
    tags: [...entry.definitionTags, ...entry.termTags].map((t) => t.name).filter(Boolean),
    text: glossaryToText(entry.glossary, BRIEF_TEXT_LEN),
  };
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

/** 预热：构建 kuromoji 词典树并尝试加载词典模块。服务启动时调用可消除首次请求的延迟。 */
export async function warmup(): Promise<void> {
  await getTokenizer();
  await initDict();
}

export async function analyze(text: string): Promise<AnalysisResult> {
  const t0 = Date.now();
  const warnings: string[] = [];

  let src = text ?? '';
  if (src.length > MAX_TEXT_LENGTH) {
    warnings.push(`文本超过 ${MAX_TEXT_LENGTH} 字，已截断到前 ${MAX_TEXT_LENGTH} 字进行分析。`);
    src = src.slice(0, MAX_TEXT_LENGTH);
  }

  if (!src.trim()) {
    return {
      text: src,
      sentences: [],
      words: [],
      dictionaries: [],
      stats: { chars: src.length, words: 0, sentences: 0, unknownWords: 0, ms: Date.now() - t0 },
      warnings,
    };
  }

  /* 1. 分句 + 分词 */
  const rawSentences = splitSentences(src);
  const perSentenceTokens = await Promise.all(
    rawSentences.map((s) => tokenizeWithOffsets(s.text, s.start)),
  );

  /* 2. 复合名词候选先批量校验一次，避免在 chunker 里做 N+1 查询 */
  const compoundQueries: DictQuery[] = [];
  for (const tokens of perSentenceTokens) compoundQueries.push(...collectCompoundCandidates(tokens));
  const compoundHits = await lookupTermsBatch(compoundQueries, 1);
  const acceptedCompounds = new Set<string>();
  for (const q of compoundQueries) {
    const hit = compoundHits.get(queryKey(q.term, q.reading));
    if (hit && hit.length > 0) acceptedCompounds.add(q.term);
  }

  /* 3. 词单位合并 */
  const words: Word[] = [];
  for (let si = 0; si < rawSentences.length; si++) {
    words.push(...chunk(perSentenceTokens[si], { sentenceIndex: si, acceptedCompounds }));
  }

  /* 4. 补齐 token 未覆盖的片段（空白、被 kuromoji 丢弃的字符），并编号 */
  const filled: Word[] = [];
  let cursor = 0;
  for (const w of words) {
    if (w.start > cursor) filled.push(makeGapWord(src, cursor, w.start, w.sentenceIndex));
    filled.push(w);
    cursor = Math.max(cursor, w.end);
  }
  if (cursor < src.length) {
    const lastIndex = Math.max(0, rawSentences.length - 1);
    filled.push(makeGapWord(src, cursor, src.length, lastIndex));
  }
  filled.forEach((w, i) => {
    w.id = i;
  });

  /* 5. 助词语境判定（需要 id 已分配） */
  annotateParticles(filled);

  /* 6. 批量查词典：所有候选合成一次查询 */
  const lexical = filled.filter(isLexical);
  // 标点与空白不是词汇项，不参与查词，也不应被 UI 弱化为「未知词」
  for (const w of filled) if (!isLexical(w)) w.unknown = false;
  const candidateMap = new Map<number, DictQuery[]>();
  const allQueries: DictQuery[] = [];
  for (const w of lexical) {
    const cands = candidatesFor(w);
    candidateMap.set(w.id, cands);
    allQueries.push(...cands);
  }
  const entryMap = await lookupTermsBatch(allQueries, BRIEF_LIMIT + 5);

  const extrasQueries: DictQuery[] = [];
  const chosen = new Map<number, DictQuery>();
  for (const w of lexical) {
    const cands = candidateMap.get(w.id) ?? [];
    let entries: DictEntry[] = [];
    let hitQuery: DictQuery | undefined;
    for (const q of cands) {
      const found = entryMap.get(queryKey(q.term, q.reading));
      if (found && found.length > 0) {
        entries = found;
        hitQuery = q;
        break;
      }
    }
    w.brief = entries.slice(0, BRIEF_LIMIT).map(toBrief);
    w.hasMore = entries.length > BRIEF_LIMIT;
    w.unknown = entries.length === 0;
    const q = hitQuery ?? { term: w.lemma, reading: w.lemmaReading || undefined };
    chosen.set(w.id, q);
    extrasQueries.push(q);
  }

  /* 7. 声调与频率 */
  const extras = await lookupExtras(extrasQueries);
  if (extras.pitch.size > 0 || extras.frequency.size > 0) {
    for (const w of lexical) {
      const q = chosen.get(w.id);
      if (!q) continue;
      const key = queryKey(q.term, q.reading);
      w.pitch = extras.pitch.get(key) ?? [];
      w.frequency = extras.frequency.get(key) ?? [];
    }
  }

  /* 8. 句子索引 */
  const sentences: Sentence[] = rawSentences.map((s) => ({
    index: s.index,
    start: s.start,
    end: s.end,
    text: s.text,
    wordIds: [],
  }));
  for (const w of filled) {
    const s = sentences[w.sentenceIndex];
    if (s) s.wordIds.push(w.id);
  }

  const dictionaries = (await listDictionaries()).map((d) => ({
    id: d.id,
    title: d.title,
    kind: d.kind,
    priority: d.priority,
  }));

  return {
    text: src,
    sentences,
    words: filled,
    dictionaries,
    stats: {
      chars: src.length,
      words: lexical.length,
      sentences: sentences.length,
      unknownWords: lexical.filter((w) => w.unknown).length,
      ms: Date.now() - t0,
    },
    warnings,
  };
}
