/**
 * Yomitan 词典各 bank 文件的行解析。
 * 全部输入按 unknown 处理：真实词典里字段缺失、类型不一致的情况非常多，
 * 解析失败的行一律丢弃而不是让整次导入炸掉。
 */
import type { GlossaryNode, SCNode, TagInfo } from '../../shared/types.ts';

export interface DictIndexInfo {
  title: string;
  /** format ?? version ?? 1；<= 2 走旧版 bank 布局 */
  format: number;
  revision: string;
  sequenced: boolean;
  author?: string;
  url?: string;
  description?: string;
  attribution?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  frequencyMode?: 'occurrence-based' | 'rank-based';
  /** 旧版 (format 1/2) 把标签定义内联在 index.json 里 */
  tagMeta: TagInfo[];
}

export interface TermRow {
  expression: string;
  reading: string;
  definitionTags: string;
  termTags: string;
  rules: string;
  score: number;
  sequence: number;
  glossary: GlossaryNode[];
}

export interface KanjiRow {
  character: string;
  onyomi: string;
  kunyomi: string;
  tags: string;
  meanings: string[];
  stats: Record<string, string>;
}

export interface FreqData {
  reading: string;
  value: number;
  displayValue: string;
}

export interface PitchData {
  reading: string;
  pitches: { position: number; nasal?: number[]; devoice?: number[]; tags?: string[] }[];
}

export type MetaRow =
  | { expression: string; mode: 'freq'; reading: string; data: FreqData }
  | { expression: string; mode: 'pitch'; reading: string; data: PitchData }
  | { expression: string; mode: 'ipa'; reading: string; data: unknown };

/* ────────────────────────── 基础收窄工具 ────────────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function num(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** 空格分隔的标签串，顺带清掉多余空白 */
function tagString(v: unknown): string {
  return str(v).trim().replace(/\s+/g, ' ');
}

export function splitTags(v: string): string[] {
  return v ? v.split(' ').filter(Boolean) : [];
}

/** number | number[] → number[] */
function numArray(v: unknown): number[] | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return [v];
  if (Array.isArray(v)) {
    const out = v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    return out.length ? out : undefined;
  }
  return undefined;
}

function strArray(v: unknown): string[] | undefined {
  if (typeof v === 'string') return splitTags(tagString(v));
  if (Array.isArray(v)) {
    const out = v.map(str).filter(Boolean);
    return out.length ? out : undefined;
  }
  return undefined;
}

/* ────────────────────────── index.json ────────────────────────── */

export function parseIndex(raw: unknown, fallbackTitle: string): DictIndexInfo {
  const obj = isRecord(raw) ? raw : {};
  const format = num(obj.format ?? obj.version, 1) || 1;
  const freqMode = str(obj.frequencyMode);
  const info: DictIndexInfo = {
    title: str(obj.title).trim() || fallbackTitle,
    format,
    revision: str(obj.revision).trim(),
    sequenced: obj.sequenced === true,
    tagMeta: [],
  };
  const author = str(obj.author).trim();
  const url = str(obj.url).trim();
  const description = str(obj.description).trim();
  const attribution = str(obj.attribution).trim();
  const sourceLanguage = str(obj.sourceLanguage).trim();
  const targetLanguage = str(obj.targetLanguage).trim();
  if (author) info.author = author;
  if (url) info.url = url;
  if (description) info.description = description;
  if (attribution) info.attribution = attribution;
  if (sourceLanguage) info.sourceLanguage = sourceLanguage;
  if (targetLanguage) info.targetLanguage = targetLanguage;
  if (freqMode === 'occurrence-based' || freqMode === 'rank-based') info.frequencyMode = freqMode;

  if (isRecord(obj.tagMeta)) {
    for (const [name, value] of Object.entries(obj.tagMeta)) {
      if (!isRecord(value)) continue;
      info.tagMeta.push({
        name,
        category: str(value.category),
        order: num(value.order),
        notes: str(value.notes),
        score: num(value.score),
      });
    }
  }
  return info;
}

/* ────────────────────────── term_bank ────────────────────────── */

function toGlossaryNode(v: unknown): GlossaryNode | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (isRecord(v)) {
    const type = str(v.type);
    if (type === 'text') return { type: 'text', text: str(v.text) };
    if (type === 'image') {
      const path = str(v.path);
      return path ? ({ ...v, type: 'image', path } as GlossaryNode) : null;
    }
    if (type === 'structured-content') return { type: 'structured-content', content: v.content as SCNode };
    // 少数词典的 deinflection / 无 type 对象对纯文本展示没有意义，直接丢弃
    return null;
  }
  if (Array.isArray(v)) return { type: 'structured-content', content: v as SCNode };
  return null;
}

/**
 * term_bank 行。
 * v3: [expression, reading, definitionTags, rules, score, glossary[], sequence, termTags]
 * v1: [expression, reading, definitionTags, rules, score, ...glossaryStrings]
 * index.json 声称的版本并不总是可信，改用「第 6 项是否为数组」判定，两种布局都能吃。
 */
export function parseTermRow(raw: unknown): TermRow | null {
  if (!Array.isArray(raw) || raw.length < 5) return null;
  const expression = str(raw[0]);
  const reading = str(raw[1]);
  if (!expression && !reading) return null;

  const base = {
    expression: expression || reading,
    reading: expression ? reading : '',
    definitionTags: tagString(raw[2]),
    rules: tagString(raw[3]),
    score: num(raw[4]),
  };

  const glossary: GlossaryNode[] = [];
  if (Array.isArray(raw[5])) {
    for (const item of raw[5] as unknown[]) {
      const node = toGlossaryNode(item);
      if (node !== null) glossary.push(node);
    }
    return {
      ...base,
      glossary,
      sequence: num(raw[6], -1),
      termTags: tagString(raw[7]),
    };
  }

  for (let i = 5; i < raw.length; i++) {
    const node = toGlossaryNode(raw[i]);
    if (node !== null) glossary.push(node);
  }
  return { ...base, glossary, sequence: -1, termTags: '' };
}

/* ────────────────────────── kanji_bank ────────────────────────── */

/**
 * v3: [character, onyomi, kunyomi, tags, meanings[], stats{}]
 * v1: [character, onyomi, kunyomi, tags, ...meanings]
 */
export function parseKanjiRow(raw: unknown): KanjiRow | null {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  const character = str(raw[0]);
  if (!character) return null;

  const stats: Record<string, string> = {};
  let meanings: string[] = [];
  if (Array.isArray(raw[4])) {
    meanings = (raw[4] as unknown[]).map(str).filter(Boolean);
    if (isRecord(raw[5])) {
      for (const [k, v] of Object.entries(raw[5])) stats[k] = str(v);
    }
  } else {
    meanings = raw.slice(4).map(str).filter(Boolean);
  }

  return {
    character,
    onyomi: tagString(raw[1]),
    kunyomi: tagString(raw[2]),
    tags: tagString(raw[3]),
    meanings,
    stats,
  };
}

/* ────────────────────────── term_meta_bank ────────────────────────── */

/** freq 的 data 有 5 种以上写法，统一成 {value:number, displayValue:string} */
function parseFreqValue(v: unknown): { value: number; displayValue: string } {
  if (typeof v === 'number' && Number.isFinite(v)) return { value: v, displayValue: String(v) };
  if (typeof v === 'string') {
    const parsed = Number(v.replace(/[\s,]/g, ''));
    return { value: Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER, displayValue: v };
  }
  if (isRecord(v)) {
    const inner = parseFreqValue(v.value);
    const display = str(v.displayValue);
    return { value: inner.value, displayValue: display || inner.displayValue };
  }
  return { value: Number.MAX_SAFE_INTEGER, displayValue: '' };
}

function parseFreqData(data: unknown): FreqData {
  // {reading, frequency} 形态：频率挂在读音上
  if (isRecord(data) && 'frequency' in data) {
    const inner = parseFreqValue(data.frequency);
    return { reading: str(data.reading), value: inner.value, displayValue: inner.displayValue };
  }
  const inner = parseFreqValue(data);
  return { reading: '', value: inner.value, displayValue: inner.displayValue };
}

function parsePitchData(data: unknown): PitchData | null {
  if (!isRecord(data)) return null;
  const reading = str(data.reading);
  const raw = Array.isArray(data.pitches) ? (data.pitches as unknown[]) : [];
  const pitches: PitchData['pitches'] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const entry: PitchData['pitches'][number] = { position: num(item.position, 0) };
    const nasal = numArray(item.nasal);
    const devoice = numArray(item.devoice);
    const tags = strArray(item.tags);
    if (nasal) entry.nasal = nasal;
    if (devoice) entry.devoice = devoice;
    if (tags) entry.tags = tags;
    pitches.push(entry);
  }
  if (!reading && !pitches.length) return null;
  return { reading, pitches };
}

/** [expression, mode, data] */
export function parseMetaRow(raw: unknown): MetaRow | null {
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const expression = str(raw[0]);
  const mode = str(raw[1]);
  if (!expression) return null;
  if (mode === 'freq') {
    const data = parseFreqData(raw[2]);
    return { expression, mode: 'freq', reading: data.reading, data };
  }
  if (mode === 'pitch') {
    const data = parsePitchData(raw[2]);
    if (!data) return null;
    return { expression, mode: 'pitch', reading: data.reading, data };
  }
  if (mode === 'ipa') {
    const reading = isRecord(raw[2]) ? str(raw[2].reading) : '';
    return { expression, mode: 'ipa', reading, data: raw[2] };
  }
  return null;
}

/* ────────────────────────── tag_bank ────────────────────────── */

/** [name, category, order, notes, score] */
export function parseTagRow(raw: unknown): TagInfo | null {
  if (!Array.isArray(raw) || raw.length < 1) return null;
  const name = str(raw[0]);
  if (!name) return null;
  return {
    name,
    category: str(raw[1]),
    order: num(raw[2]),
    notes: str(raw[3]),
    score: num(raw[4]),
  };
}
