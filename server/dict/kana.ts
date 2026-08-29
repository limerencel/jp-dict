/**
 * 词典模块自用的假名工具。
 *
 * 刻意不依赖 shared/kana.ts：查询键（*_norm 列）的归一化规则必须与入库时逐字节一致，
 * 一旦别处改了实现就会静默查不到词，所以由本模块独占。
 */

const KATAKANA_START = 0x30a1; // ァ
const KATAKANA_END = 0x30f6; // ヶ（ヷヸヹヺ 无对应平假名，故不含）
const KANA_OFFSET = 0x60;

/** 不单独成拍的小书写假名 */
const SMALL_KANA = new Set('ぁぃぅぇぉゃゅょゎゕゖァィゥェォャュョヮヵヶ');

/** 零宽字符与异体字选择符，词典里偶尔混进来 */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;

/** 片假名 → 平假名（含长音符与浊点保持原样） */
export function toHiragana(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    out += code >= KATAKANA_START && code <= KATAKANA_END ? String.fromCodePoint(code - KANA_OFFSET) : ch;
  }
  return out;
}

/**
 * 生成查询键：NFKC（顺带把半角片假名、全角字母、分离的浊点合并）→ 小写 → 片假名转平假名。
 * 长音符 ー 原样保留：入库与查询两侧一致即可，强行展开反而会和词典写法冲突。
 */
export function normalizeKey(input: string): string {
  if (!input) return '';
  const cleaned = input.normalize('NFKC').replace(INVISIBLE, '').trim();
  return toHiragana(cleaned.toLowerCase());
}

/** 拍数：拗音（きゃ/しゅ 等）的小假名不计，促音 っ 与长音 ー 各算 1 拍 */
export function moraCount(kana: string): number {
  let n = 0;
  for (const ch of kana) {
    if (!SMALL_KANA.has(ch)) n += 1;
  }
  return n;
}

/** 由下降位置与拍数推出型名 */
export function pitchPatternLabel(position: number, kana: string): string {
  const mora = moraCount(kana);
  if (position <= 0) return '平板';
  if (position === 1) return '頭高';
  if (position >= mora) return '尾高';
  return '中高';
}
