/**
 * kuromoji 单例封装、分句、以及 token 在原文中的精确偏移校准。
 */
import kuromoji from '@sglkc/kuromoji';
import { createRequire } from 'node:module';

/* ────────────────────────────── kuromoji 类型 ────────────────────────────── */

/** @sglkc/kuromoji 未提供类型定义，这里按实测字段自行声明 */
export interface KuromojiToken {
  word_id: number;
  word_type: 'KNOWN' | 'UNKNOWN' | string;
  /** 1-based 字符位置（kuromoji 自己的计数，会忽略部分空白，不能直接当原文偏移用） */
  word_position: number;
  surface_form: string;
  pos: string;
  pos_detail_1: string;
  pos_detail_2: string;
  pos_detail_3: string;
  conjugated_type: string;
  conjugated_form: string;
  basic_form: string;
  /** 片假名读音；UNKNOWN 词可能缺失 */
  reading?: string;
  pronunciation?: string;
}

/** 带原文偏移的 token */
export interface PositionedToken extends KuromojiToken {
  /** 在原文中的字符偏移 [start, end) */
  start: number;
  end: number;
}

interface KuromojiTokenizer {
  tokenize(text: string): KuromojiToken[];
}

interface KuromojiBuilder {
  build(cb: (err: Error | null, tokenizer: KuromojiTokenizer) => void): void;
}

interface KuromojiModule {
  builder(opts: { dicPath: string }): KuromojiBuilder;
}

/* ────────────────────────────── 单例 ────────────────────────────── */

let tokenizerPromise: Promise<KuromojiTokenizer> | null = null;

export function getTokenizer(): Promise<KuromojiTokenizer> {
  if (tokenizerPromise) return tokenizerPromise;
  tokenizerPromise = new Promise<KuromojiTokenizer>((resolve, reject) => {
    const require_ = createRequire(import.meta.url);
    const dicPath = require_.resolve('@sglkc/kuromoji/package.json').replace(/package\.json$/, 'dict');
    (kuromoji as unknown as KuromojiModule).builder({ dicPath }).build((err, tk) => {
      if (err) reject(err);
      else resolve(tk);
    });
  });
  // 构建失败时允许下次重试
  tokenizerPromise.catch(() => {
    tokenizerPromise = null;
  });
  return tokenizerPromise;
}

/* ────────────────────────────── 分句 ────────────────────────────── */

export interface RawSentence {
  index: number;
  start: number;
  end: number;
  text: string;
}

/** 句末标点 */
const TERMINATORS = new Set(['。', '！', '？', '!', '?', '…', '．', '\n']);
/** 允许跟在句末标点之后、仍算同一句的收尾字符 */
const CLOSERS = new Set(['」', '』', '）', ')', '”', '’', '"', "'", '】', '〉', '》', '〕', '］', ']', '｝', '}']);
const OPENERS: Record<string, string> = {
  '「': '」', '『': '』', '（': '）', '(': ')', '【': '】',
  '〈': '〉', '《': '》', '〔': '〕', '［': ']', '[': ']', '｛': '}', '{': '}',
};

/**
 * 分句。启发式规则：
 * - 括号/引号内部的句点不切分（维护一个开闭栈）；
 * - 句末标点连写（「!?」「……」）算一个边界；
 * - 标点后的闭引号并入本句。
 */
export function splitSentences(text: string): RawSentence[] {
  const out: RawSentence[] = [];
  const stack: string[] = [];
  let start = 0;

  const flush = (end: number): void => {
    const raw = text.slice(start, end);
    if (raw.trim().length > 0) {
      out.push({ index: out.length, start, end, text: raw });
    } else if (raw.length > 0 && out.length > 0) {
      // 纯空白并入上一句尾，避免偏移空洞
      out[out.length - 1].end = end;
      out[out.length - 1].text = text.slice(out[out.length - 1].start, end);
    }
    start = end;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (OPENERS[ch]) {
      stack.push(OPENERS[ch]);
      continue;
    }
    if (stack.length > 0 && ch === stack[stack.length - 1]) {
      stack.pop();
      continue;
    }
    if (stack.length > 0) continue;
    if (!TERMINATORS.has(ch)) continue;

    let j = i;
    // 吞掉连续的句末标点
    while (j + 1 < text.length && TERMINATORS.has(text[j + 1]) && text[j + 1] !== '\n') j++;
    // 吞掉紧跟的闭引号
    while (j + 1 < text.length && CLOSERS.has(text[j + 1])) j++;
    flush(j + 1);
    i = j;
  }
  if (start < text.length) flush(text.length);
  return out.map((s, index) => ({ ...s, index }));
}

/* ────────────────────────────── 偏移校准 ────────────────────────────── */

/**
 * 对一段文本分词，并把每个 token 定位回原文。
 * kuromoji 会吞掉空白等字符，因此用「游标 + indexOf」逐个锚定 surface_form，
 * 保证偏移绝对正确（找不到时退化为紧邻上一 token，不会错位累积）。
 *
 * @param text  待分词片段
 * @param base  该片段在整篇原文中的起始偏移
 */
export async function tokenizeWithOffsets(text: string, base = 0): Promise<PositionedToken[]> {
  if (!text) return [];
  const tokenizer = await getTokenizer();
  const tokens = tokenizer.tokenize(text);
  const out: PositionedToken[] = [];
  let cursor = 0;

  for (const token of tokens) {
    const surface = token.surface_form;
    if (!surface) continue;
    let idx = text.indexOf(surface, cursor);
    if (idx < 0) {
      // 理论上不会发生；保守地放在游标处，宁可长度不精确也不丢偏移
      idx = Math.min(cursor, Math.max(0, text.length - surface.length));
    }
    out.push({ ...token, start: base + idx, end: base + idx + surface.length });
    cursor = idx + surface.length;
  }
  return out;
}
