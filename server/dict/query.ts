/**
 * 查询层。所有查询只覆盖 enabled 的词典，结果按词典优先级排序。
 * 语句与标签表都做了缓存，长文本分析时会被高频调用。
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  DictEntry,
  DictionaryMeta,
  FrequencyInfo,
  GlossaryNode,
  KanjiEntry,
  PitchAccent,
  TagInfo,
} from '../../shared/types.ts';
import { colJson, colNum, colText, getDb } from './db.ts';
import type { Row } from './db.ts';
import { normalizeKey, pitchPatternLabel } from './kana.ts';
import { splitTags } from './parse.ts';
import type { FreqData, PitchData } from './parse.ts';
import { DICT_COLUMNS, rowToMeta } from './meta.ts';

/** 单个归一化键最多取多少行，防止极端词条拖垮分析 */
const ROW_CAP = 2000;
const DEFAULT_LIMIT = 32;

const TERM_COLUMNS = `t.id, t.dict_id, t.expression, t.reading, t.expression_norm, t.reading_norm,
  t.definition_tags, t.term_tags, t.rules, t.score, t.sequence, t.glossary_json, t.alias_of,
  d.title AS dict_title, d.priority AS dict_priority`;

/** MDict 别名行的释义在目标行上 */
const SQL_ALIAS_TARGET = `SELECT id, expression, reading, definition_tags, term_tags, rules, sequence, glossary_json
  FROM terms WHERE id = ?`;

// INDEXED BY 不是优化而是保险：统计信息缺失或过期时 SQLite 会选全表扫描，
// 20 万词条的词典上单次查词会从微秒级掉到百毫秒级。这里强制走等值索引。
const SQL_TERM_BY_EXPR = `SELECT ${TERM_COLUMNS} FROM terms t INDEXED BY idx_terms_expr
  JOIN dictionaries d ON d.id = t.dict_id
  WHERE t.expression_norm = ? AND d.enabled = 1 ORDER BY t.score DESC LIMIT ${ROW_CAP}`;
const SQL_TERM_BY_READING = `SELECT ${TERM_COLUMNS} FROM terms t INDEXED BY idx_terms_read
  JOIN dictionaries d ON d.id = t.dict_id
  WHERE t.reading_norm = ? AND d.enabled = 1 ORDER BY t.score DESC LIMIT ${ROW_CAP}`;
const SQL_META = `SELECT m.expression, m.reading, m.reading_norm, m.data_json, d.title AS dict_title, d.priority AS dict_priority
  FROM term_meta m INDEXED BY idx_meta_expr_mode
  JOIN dictionaries d ON d.id = m.dict_id
  WHERE m.expression_norm = ? AND m.mode = ? AND d.enabled = 1 ORDER BY d.priority DESC LIMIT ${ROW_CAP}`;
const SQL_KANJI = `SELECT k.dict_id, k.character, k.onyomi, k.kunyomi, k.tags, k.meanings_json, k.stats_json,
  d.title AS dict_title, d.priority AS dict_priority
  FROM kanji k INDEXED BY idx_kanji_char
  JOIN dictionaries d ON d.id = k.dict_id
  WHERE k.character = ? AND d.enabled = 1 ORDER BY d.priority DESC`;

/* ────────────────────────── 缓存 ────────────────────────── */

let cachedConn: DatabaseSync | null = null;
const stmtCache = new Map<string, StatementSync>();
const tagCache = new Map<number, Map<string, TagInfo>>();
let dictCache: DictionaryMeta[] | null = null;

/** 导入 / 删除 / 改开关后必须调用 */
export function invalidateCaches(): void {
  stmtCache.clear();
  tagCache.clear();
  dictCache = null;
  cachedConn = null;
}

/** 库被关闭又重开后，旧的预编译语句与缓存全部作废 */
function ensureConn(): DatabaseSync {
  const conn = getDb();
  if (conn !== cachedConn) {
    stmtCache.clear();
    tagCache.clear();
    dictCache = null;
    cachedConn = conn;
  }
  return conn;
}

function stmt(sql: string): StatementSync {
  const conn = ensureConn();
  let prepared = stmtCache.get(sql);
  if (!prepared) {
    prepared = conn.prepare(sql);
    stmtCache.set(sql, prepared);
  }
  return prepared;
}

function tagsOf(dictId: number): Map<string, TagInfo> {
  let map = tagCache.get(dictId);
  if (map) return map;
  map = new Map();
  const rows = stmt('SELECT name, category, ord, notes, score FROM tags WHERE dict_id = ?').all(dictId);
  for (const row of rows) {
    const name = colText(row.name);
    map.set(name, {
      name,
      category: colText(row.category),
      order: colNum(row.ord),
      notes: colText(row.notes),
      score: colNum(row.score),
    });
  }
  tagCache.set(dictId, map);
  return map;
}

/** 标签串 → TagInfo[]；tag_bank 里没定义的标签退化成裸名字 */
function resolveTags(dictId: number, raw: string): TagInfo[] {
  const names = splitTags(raw);
  if (!names.length) return [];
  const defs = tagsOf(dictId);
  return names.map(
    (name) => defs.get(name) ?? { name, category: '', order: 0, notes: '', score: 0 },
  );
}

/* ────────────────────────── 词典列表 ────────────────────────── */

export function listDictionaries(): DictionaryMeta[] {
  ensureConn();
  if (dictCache) return dictCache.map((d) => ({ ...d }));
  const rows = stmt(`SELECT ${DICT_COLUMNS} FROM dictionaries ORDER BY priority DESC, id ASC`).all();
  dictCache = rows.map(rowToMeta);
  return dictCache.map((d) => ({ ...d }));
}

export function getDictionary(id: number): DictionaryMeta | null {
  const row = stmt(`SELECT ${DICT_COLUMNS} FROM dictionaries WHERE id = ?`).get(id);
  return row ? rowToMeta(row) : null;
}

/** 作用域化后的词典自带样式；没有则 null */
export function getDictionaryStyle(id: number): string | null {
  const row = stmt('SELECT css FROM dictionaries WHERE id = ?').get(id);
  if (!row) return null;
  const css = colText(row.css);
  return css || null;
}

/* ────────────────────────── 词条 ────────────────────────── */

interface Candidate {
  entry: DictEntry;
  /** 通过 expression 精确命中（而非仅 reading 命中） */
  exact: boolean;
  /** 有效读音的归一化形式：无 reading 的假名词条用 expression 本身 */
  effectiveReadingNorm: string;
  rowId: number;
  /** MDict 重定向目标行号，0 表示本行自带释义 */
  aliasOf: number;
}

function rowToCandidate(row: Row, queryNorm: string): Candidate {
  const dictId = colNum(row.dict_id);
  const expressionNorm = colText(row.expression_norm);
  const readingNorm = colText(row.reading_norm);
  const entry: DictEntry = {
    dictId,
    dictTitle: colText(row.dict_title),
    dictPriority: colNum(row.dict_priority),
    term: colText(row.expression),
    reading: colText(row.reading),
    definitionTags: resolveTags(dictId, colText(row.definition_tags)),
    termTags: resolveTags(dictId, colText(row.term_tags)),
    rules: splitTags(colText(row.rules)),
    score: colNum(row.score),
    sequence: colNum(row.sequence),
    glossary: colJson<GlossaryNode[]>(row.glossary_json, []),
  };
  return {
    entry,
    exact: expressionNorm === queryNorm,
    effectiveReadingNorm: readingNorm || expressionNorm,
    rowId: colNum(row.id),
    aliasOf: colNum(row.alias_of),
  };
}

/**
 * 把 MDict 别名行补成完整词条：释义取目标行，检索到的表记保留别名自己的写法
 * （查「いい」应显示 いい 而不是 良い），读音缺失时用目标行的。
 * 返回 false 表示目标行已失效，该候选应丢弃。
 */
function dereference(candidate: Candidate): boolean {
  if (!candidate.aliasOf) return true;
  const row = stmt(SQL_ALIAS_TARGET).get(candidate.aliasOf);
  if (!row) return false;
  const entry = candidate.entry;
  entry.glossary = colJson<GlossaryNode[]>(row.glossary_json, []);
  entry.sequence = colNum(row.sequence);
  if (!entry.reading) entry.reading = colText(row.reading);
  if (!entry.definitionTags.length) entry.definitionTags = resolveTags(entry.dictId, colText(row.definition_tags));
  if (!entry.termTags.length) entry.termTags = resolveTags(entry.dictId, colText(row.term_tags));
  if (!entry.rules.length) entry.rules = splitTags(colText(row.rules));
  return entry.glossary.length > 0;
}

function fetchCandidates(queryNorm: string): Candidate[] {
  if (!queryNorm) return [];
  const seen = new Set<number>();
  const out: Candidate[] = [];
  for (const sql of [SQL_TERM_BY_EXPR, SQL_TERM_BY_READING]) {
    for (const row of stmt(sql).all(queryNorm)) {
      const candidate = rowToCandidate(row, queryNorm);
      if (seen.has(candidate.rowId)) continue;
      seen.add(candidate.rowId);
      out.push(candidate);
    }
  }
  return out;
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.entry.dictPriority !== b.entry.dictPriority) return b.entry.dictPriority - a.entry.dictPriority;
  if (a.entry.score !== b.entry.score) return b.entry.score - a.entry.score;
  if (a.exact !== b.exact) return a.exact ? -1 : 1;
  return a.rowId - b.rowId;
}

function finishCandidates(candidates: Candidate[], readingNorm: string, limit: number): DictEntry[] {
  let picked = candidates;
  if (readingNorm) {
    // 同形异读过滤（生：なま / せい）。过滤到空说明读音信息不可靠，退回全量
    const filtered = candidates.filter((c) => c.effectiveReadingNorm === readingNorm);
    if (filtered.length) picked = filtered;
  }

  // 同一目标可能既被本体行命中、又被别名行命中，只保留一份
  const targets = new Set<number>();
  for (const c of picked) if (!c.aliasOf) targets.add(c.rowId);
  const unique: Candidate[] = [];
  for (const c of picked.sort(compareCandidates)) {
    const target = c.aliasOf || c.rowId;
    if (c.aliasOf && targets.has(target)) continue;
    targets.add(target);
    if (!dereference(c)) continue;
    unique.push(c);
    if (unique.length >= limit) break;
  }
  return unique.map((c) => c.entry);
}

export function lookupTerm(term: string, reading?: string, limit = DEFAULT_LIMIT): DictEntry[] {
  const queryNorm = normalizeKey(term);
  if (!queryNorm) return [];
  return finishCandidates(fetchCandidates(queryNorm), normalizeKey(reading ?? ''), limit);
}

export function lookupTermsBatch(
  queries: { term: string; reading?: string }[],
  limitPerQuery = DEFAULT_LIMIT,
): Map<string, DictEntry[]> {
  const result = new Map<string, DictEntry[]>();
  const byNorm = new Map<string, Candidate[]>();
  for (const query of queries) {
    const key = `${query.term}\u0000${query.reading ?? ''}`;
    if (result.has(key)) continue;
    const queryNorm = normalizeKey(query.term);
    if (!queryNorm) {
      result.set(key, []);
      continue;
    }
    let candidates = byNorm.get(queryNorm);
    if (!candidates) {
      candidates = fetchCandidates(queryNorm);
      byNorm.set(queryNorm, candidates);
    }
    // 同一批里不同 reading 会各自排序，复制一份避免 sort 打乱共享数组
    result.set(key, finishCandidates(candidates.slice(), normalizeKey(query.reading ?? ''), limitPerQuery));
  }
  return result;
}

/* ────────────────────────── 汉字 ────────────────────────── */

export function lookupKanji(characters: string[]): KanjiEntry[] {
  const out: KanjiEntry[] = [];
  const seen = new Set<string>();
  for (const character of characters) {
    if (!character || seen.has(character)) continue;
    seen.add(character);
    for (const row of stmt(SQL_KANJI).all(character)) {
      const dictId = colNum(row.dict_id);
      out.push({
        dictId,
        dictTitle: colText(row.dict_title),
        character: colText(row.character),
        onyomi: splitTags(colText(row.onyomi)),
        kunyomi: splitTags(colText(row.kunyomi)),
        tags: resolveTags(dictId, colText(row.tags)),
        meanings: colJson<string[]>(row.meanings_json, []),
        stats: colJson<Record<string, string>>(row.stats_json, {}),
      });
    }
  }
  return out;
}

/* ────────────────────────── 声调 ────────────────────────── */

export function lookupPitch(term: string, reading?: string): PitchAccent[] {
  const termNorm = normalizeKey(term);
  const readingNorm = normalizeKey(reading ?? '');
  if (!termNorm && !readingNorm) return [];

  const keys = termNorm ? [termNorm] : [];
  // 声调词典按表记（汉字）建键；查假名形时也可能命中，两个键都试
  if (readingNorm && readingNorm !== termNorm) keys.push(readingNorm);

  const all: PitchAccent[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    for (const row of stmt(SQL_META).all(key, 'pitch')) {
      const data = colJson<PitchData>(row.data_json, { reading: '', pitches: [] });
      const entryReading = data.reading || colText(row.reading) || colText(row.expression);
      for (const pitch of data.pitches ?? []) {
        const accent: PitchAccent = {
          dictTitle: colText(row.dict_title),
          reading: entryReading,
          position: pitch.position,
          patternLabel: pitchPatternLabel(pitch.position, entryReading),
        };
        if (pitch.nasal?.length) accent.nasal = pitch.nasal;
        if (pitch.devoice?.length) accent.devoice = pitch.devoice;
        if (pitch.tags?.length) accent.tags = pitch.tags;
        const dedupe = `${accent.dictTitle}\u0000${accent.reading}\u0000${accent.position}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        all.push(accent);
      }
    }
  }

  if (readingNorm) {
    const filtered = all.filter((a) => normalizeKey(a.reading) === readingNorm);
    if (filtered.length) return filtered;
  }
  return all;
}

/* ────────────────────────── 频率 ────────────────────────── */

function collectFrequency(key: string, mode: string, out: FrequencyInfo[], seen: Set<string>): void {
  for (const row of stmt(SQL_META).all(key, mode)) {
    const data = colJson<FreqData>(row.data_json, { reading: '', value: Number.MAX_SAFE_INTEGER, displayValue: '' });
    const value = Number.isFinite(data.value) ? data.value : Number.MAX_SAFE_INTEGER;
    const info: FrequencyInfo = {
      dictTitle: colText(row.dict_title),
      value,
      displayValue: data.displayValue || String(value),
    };
    const entryReading = data.reading || colText(row.reading);
    if (entryReading) info.reading = entryReading;
    const dedupe = `${info.dictTitle}\u0000${info.reading ?? ''}\u0000${info.value}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(info);
  }
}

export function lookupFrequency(term: string, reading?: string): FrequencyInfo[] {
  const termNorm = normalizeKey(term);
  const readingNorm = normalizeKey(reading ?? '');
  if (!termNorm && !readingNorm) return [];

  const out: FrequencyInfo[] = [];
  const seen = new Set<string>();
  if (termNorm) {
    collectFrequency(termNorm, 'freq', out, seen);
    // 单字时顺带取汉字频率表
    if ([...term].length === 1) collectFrequency(termNorm, 'kanji-freq', out, seen);
  }
  // 表记查不到时退回假名形（频率表常只收假名条目）
  if (!out.length && readingNorm && readingNorm !== termNorm) collectFrequency(readingNorm, 'freq', out, seen);

  if (readingNorm) {
    const filtered = out.filter((f) => !f.reading || normalizeKey(f.reading) === readingNorm);
    if (filtered.length) return filtered;
  }
  return out;
}
