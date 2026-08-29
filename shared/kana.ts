/**
 * 假名工具集：纯函数、无副作用、不依赖 Node，前后端共用。
 */
import type { FuriganaSegment } from './types.ts';

/* ────────────────────────────── 字符判定 ────────────────────────────── */

const HIRA_START = 0x3041;
const HIRA_END = 0x3096;
const KATA_START = 0x30a1;
const KATA_END = 0x30f6;
/** 平假名 → 片假名的码位差 */
const KANA_OFFSET = KATA_START - HIRA_START;

/** 长音符、假名重复记号：视为假名的一部分 */
const KANA_EXTRA = new Set(['ー', '\u30fc', 'ゝ', 'ゞ', 'ヽ', 'ヾ', 'ヿ', 'ゟ']);

function cp(ch: string): number {
  return ch.codePointAt(0) ?? -1;
}

export function isHiragana(ch: string): boolean {
  const c = cp(ch);
  return c >= HIRA_START && c <= HIRA_END;
}

export function isKatakana(ch: string): boolean {
  const c = cp(ch);
  return (c >= KATA_START && c <= KATA_END) || c === 0x30f7 || c === 0x30f8 || c === 0x30f9 || c === 0x30fa;
}

export function isKana(ch: string): boolean {
  return isHiragana(ch) || isKatakana(ch) || KANA_EXTRA.has(ch);
}

export function isKanji(ch: string): boolean {
  const c = cp(ch);
  return (
    (c >= 0x4e00 && c <= 0x9fff) || // CJK 统一表意文字
    (c >= 0x3400 && c <= 0x4dbf) || // 扩展 A
    (c >= 0xf900 && c <= 0xfaff) || // 兼容表意文字
    (c >= 0x20000 && c <= 0x2ebef) || // 扩展 B~F
    c === 0x3005 || // 々
    c === 0x3006 || // 〆
    c === 0x3007 // 〇
  );
}

export function isJapanese(ch: string): boolean {
  const c = cp(ch);
  if (isKana(ch) || isKanji(ch)) return true;
  // 日文标点、全角符号
  return (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef);
}

/* ────────────────────────────── 假名转换 ────────────────────────────── */

export function toHiragana(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = cp(ch);
    if (c >= KATA_START && c <= KATA_END) out += String.fromCodePoint(c - KANA_OFFSET);
    else if (c === 0x30f4) out += 'ゔ'; // ヴ
    else out += ch;
  }
  return out;
}

export function toKatakana(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = cp(ch);
    if (c >= HIRA_START && c <= HIRA_END) out += String.fromCodePoint(c + KANA_OFFSET);
    else if (c === 0x3094) out += 'ヴ'; // ゔ
    else out += ch;
  }
  return out;
}

/** 查询用归一化键：片假名→平假名，全角空格→半角，去掉首尾空白 */
export function normalizeKana(s: string): string {
  return toHiragana(s).replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ────────────────────────────── 拍（モーラ） ────────────────────────────── */

/** 不单独成拍的小书写假名（拗音、外来语小假名） */
const SMALL_KANA = new Set([
  'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'ゃ', 'ゅ', 'ょ', 'ゎ', 'ゕ', 'ゖ',
  'ァ', 'ィ', 'ゥ', 'ェ', 'ォ', 'ャ', 'ュ', 'ョ', 'ヮ', 'ヵ', 'ヶ',
]);

/**
 * 按拍切分。拗音并入前一拍；っ/ん/ー 各自独立成拍。
 */
export function splitMora(kana: string): string[] {
  const chars = [...kana];
  const out: string[] = [];
  for (const ch of chars) {
    if (SMALL_KANA.has(ch) && out.length > 0) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

export function countMora(kana: string): number {
  return splitMora(kana).length;
}

/* ────────────────────────────── 罗马字 ────────────────────────────── */

/** 拗音等二字组合优先匹配 */
const ROMAJI_DIGRAPH: Record<string, string> = {
  きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo', きぇ: 'kye',
  ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
  しゃ: 'sha', しゅ: 'shu', しょ: 'sho', しぇ: 'she',
  じゃ: 'ja', じゅ: 'ju', じょ: 'jo', じぇ: 'je',
  ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho', ちぇ: 'che',
  ぢゃ: 'ja', ぢゅ: 'ju', ぢょ: 'jo',
  にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
  ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo',
  びゃ: 'bya', びゅ: 'byu', びょ: 'byo',
  ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
  みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
  りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo',
  ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo', ふゅ: 'fyu',
  ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo',
  てぃ: 'ti', てゅ: 'tyu', でぃ: 'di', でゅ: 'dyu',
  とぅ: 'tu', どぅ: 'du',
  うぃ: 'wi', うぇ: 'we', うぉ: 'wo',
  くぁ: 'kwa', ぐぁ: 'gwa', つぁ: 'tsa', つぃ: 'tsi', つぇ: 'tse', つぉ: 'tso',
  いぇ: 'ye',
};

const ROMAJI_SINGLE: Record<string, string> = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'wi', ゑ: 'we', を: 'wo',
  ゔ: 'vu',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
  ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa',
};

const VOWELS = new Set(['a', 'i', 'u', 'e', 'o']);

/**
 * 平文式（Hepburn）罗马字。は/へ/を 作为助词时的特殊读法由调用方处理。
 */
export function toRomaji(kana: string): string {
  const src = toHiragana(kana);
  const chars = [...src];
  const out: string[] = [];
  let sokuon = false; // 待处理的促音

  const push = (roman: string): void => {
    if (sokuon && roman) {
      const first = roman[0];
      out.push(first === 'c' ? 't' : first); // っち → tchi
      sokuon = false;
    }
    out.push(roman);
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const pair = ch + (chars[i + 1] ?? '');

    if (ch === 'っ') {
      sokuon = true;
      continue;
    }
    if (ch === 'ー' || ch === '\u30fc') {
      // 长音符：重复前一个元音字母
      const prev = out.join('');
      const last = prev[prev.length - 1];
      if (last && VOWELS.has(last)) out.push(last);
      continue;
    }
    if (ch === 'ん') {
      const next = chars[i + 1];
      const nextRoman = next ? (ROMAJI_DIGRAPH[next + (chars[i + 2] ?? '')] ?? ROMAJI_SINGLE[next] ?? '') : '';
      const head = nextRoman[0] ?? '';
      if (head === 'b' || head === 'm' || head === 'p') push('m');
      else if (VOWELS.has(head) || head === 'y') push("n'");
      else push('n');
      continue;
    }
    if (ROMAJI_DIGRAPH[pair]) {
      push(ROMAJI_DIGRAPH[pair]);
      i++;
      continue;
    }
    if (ROMAJI_SINGLE[ch]) {
      push(ROMAJI_SINGLE[ch]);
      continue;
    }
    sokuon = false;
    out.push(ch);
  }
  if (sokuon) out.push('');
  return out.join('');
}

/* ────────────────────────────── 振り仮名对齐 ────────────────────────────── */

interface Run {
  text: string;
  /** true = 纯假名段（不需要注音，同时充当对齐锚点） */
  kana: boolean;
}

function splitRuns(surface: string): Run[] {
  const runs: Run[] = [];
  for (const ch of surface) {
    const kana = isKana(ch);
    const last = runs[runs.length - 1];
    if (last && last.kana === kana) last.text += ch;
    else runs.push({ text: ch, kana });
  }
  return runs;
}

/**
 * 回溯对齐：非假名段（汉字块）可消耗任意长度读音，假名段必须逐字命中，
 * 从而把「汉字块 ↔ 其读音」精确配对。汉字段按「尽量短」优先尝试，
 * 这与送り仮名的实际分布一致（例：大人しい → 大人=おとな）。
 */
function alignRuns(runs: Run[], reading: string): string[] | null {
  const n = runs.length;
  // 剩余段落至少还需要多少字符
  const minRest: number[] = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    minRest[i] = minRest[i + 1] + (runs[i].kana ? [...runs[i].text].length : 1);
  }
  const assign: string[] = new Array(n).fill('');
  let budget = 20000;

  const solve = (ri: number, pos: number): boolean => {
    if (budget-- <= 0) return false;
    if (ri === n) return pos === reading.length;
    const run = runs[ri];
    if (run.kana) {
      const want = toHiragana(run.text);
      if (reading.startsWith(want, pos)) {
        assign[ri] = run.text;
        return solve(ri + 1, pos + want.length);
      }
      return false;
    }
    const maxLen = reading.length - pos - minRest[ri + 1];
    for (let len = 1; len <= maxLen; len++) {
      assign[ri] = reading.slice(pos, pos + len);
      if (solve(ri + 1, pos + len)) return true;
    }
    return false;
  };

  return solve(0, 0) ? assign : null;
}

/**
 * 把表层形与读音对齐成 ruby 分段。
 * 假名段不注音；汉字块尽量单独配对；失败时降级为整词一个 ruby，绝不抛异常。
 */
export function buildFurigana(surface: string, reading: string): FuriganaSegment[] {
  if (!surface) return [];
  const read = normalizeKana(reading ?? '');
  const chars = [...surface];
  const hasKanjiLike = chars.some((ch) => !isKana(ch));

  // 纯假名，或没有读音信息：不注音
  if (!hasKanjiLike || !read) return [{ text: surface }];
  if (toHiragana(surface) === read) return [{ text: surface }];

  const runs = splitRuns(surface);
  let segments: FuriganaSegment[] | null = null;
  try {
    const assign = alignRuns(runs, read);
    if (assign) {
      segments = runs.map((run, i) =>
        run.kana ? { text: run.text } : { text: run.text, ruby: assign[i] || undefined },
      );
    }
  } catch {
    segments = null;
  }

  if (!segments) segments = [{ text: surface, ruby: read }];

  // 合并相邻的无注音段，避免碎片
  const merged: FuriganaSegment[] = [];
  for (const seg of segments) {
    if (!seg.text) continue;
    const last = merged[merged.length - 1];
    if (last && last.ruby === undefined && seg.ruby === undefined) last.text += seg.text;
    else merged.push({ ...seg });
  }
  return merged;
}
