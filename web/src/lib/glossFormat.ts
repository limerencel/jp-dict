/**
 * 纯文本释义解析器（针对「研究社　新和英大辞典　第５版」这类把整条词条塞进
 * 一个字符串的 Yomitan 词典）。
 *
 * ── 研究社的排版约定 ──────────────────────────────────────────────
 *   首行  かな数字【漢字】 [ローマ字](romaji)   词头行
 *   行首  1 2 3 …                              义项编号
 *   行首  ►                                    主例（多为短语级）
 *   行首  ・                                   子例（多为完整句子）
 *   行首  ◧ ◨                                  複合語／子见出し区块
 *   行首  〜                                   派生形（〜する / 〜な）
 *   行内  ▶ ▷                                  编者注记 / 派生词说明
 *   　(U+3000)                                 例句里分隔「日文原句」与「英文译文」
 *   〔…〕                                      语义・使用场合限定
 *   【…】                                      专业领域（非词头行时）
 *   《…》                                      语域／地域标签（口・文・米・英…）
 *   〚…〛                                      词源（〚＜F〛= 源自法语）
 *   〈…〉                                      对译词的用法说明（〈集合的に〉）
 *   (…)                                        含 CJK 时是对译词的补充说明；
 *                                              纯假名且前接汉字时是注音
 *   ┏A [B]                                     A 与 B 可互换（研究社特有记号）
 *   [B]                                        同上，省略了 ┏ 的形式
 *   ｜                                          多个可选译法之间的分隔
 *   ⇒xxx / [⇒xxx, yyy] / ＝xxx                 参见其他词条
 *   *word                                      美式用法
 *   ᐦword                                      文语／旧式用法
 *   \10,000                                    反斜杠代表日元符号 ¥
 *
 * ── 解析策略 ────────────────────────────────────────────────────
 * 1. 逐行判定块类型，识别不了的一律降级为 paragraph —— 绝不丢内容。
 * 2. 例句／注记挂到「前面最近的义项」下；没有编号时挂到一个隐式义项。
 * 3. 行内用一次线性扫描切成 Inline 记号，任何未闭合的括号都退化成普通文本。
 * 4. 本文件是自包含的纯逻辑，不依赖 React / @shared，便于直接用 tsx 跑测试。
 */

/* ────────────────────────────── 数据模型 ────────────────────────────── */

/** `*word` = 美式用法；`ᐦword` = 文语／旧式用法 */
export type MarkFlavor = 'us' | 'literary';

export type Inline =
  /** 普通文本 */
  | { t: 'text'; v: string }
  /** 汉字注音：`鍬(くわ)` */
  | { t: 'ruby'; base: string; rt: string }
  /** `〔…〕` 语义／场合限定 */
  | { t: 'domain'; v: string }
  /** `【…】` 专业领域 */
  | { t: 'field'; v: string }
  /** `〈…〉` 对译词的用法说明 */
  | { t: 'usage'; v: string }
  /** `〚…〛` 词源 */
  | { t: 'etym'; v: string }
  /** `《…》` 语域／地域标签 */
  | { t: 'register'; v: string }
  /** `(…)` 对译词的中文／日文补充说明 */
  | { t: 'gloss-note'; v: string }
  /** `┏A [B]`：main 可替换为 alts 中任意一项；main 为空表示原文省略了 `┏` */
  | { t: 'alt'; main: Inline[]; alts: string[] }
  /** `⇒xxx`：v 是原文显示用文本，query 是剥掉同音号后的查询词（可能为空 = 不可点） */
  | { t: 'xref'; v: string; query: string; marker: string }
  /** `｜` 可选译法分隔 */
  | { t: 'sep' }
  /** `▶` / `▷` 编者注记（吃掉本行剩余部分） */
  | { t: 'note'; v: string; marker: string }
  /** `*word` / `ᐦword` */
  | { t: 'mark'; v: string; flavor: MarkFlavor };

export interface HeadwordBlock {
  kind: 'headword';
  kana: string;
  kanji?: string;
  romaji?: string;
  /** 同音词序号：`いい２` 的 `２` */
  homographIndex?: string;
}

export interface SenseBlock {
  kind: 'sense';
  /** 半角化后的义项编号；隐式义项为 undefined */
  number?: string;
  /** 义项开头的 `〔…〕` */
  domain?: string;
  content: Inline[];
  children: GlossBlock[];
}

export interface ExampleBlock {
  kind: 'example';
  /** `►` = primary，`・` = sub */
  level: 'primary' | 'sub';
  ja: Inline[];
  translation?: Inline[];
  domain?: string;
  /** 紧跟在一条主例后面的 `・` 子例（研究社的例句是两层结构） */
  children: ExampleBlock[];
}

/** `◧`/`◨` 複合語、`〜する` 派生形，以及紧随其后的无记号续行 */
export interface SubentryBlock {
  kind: 'subentry';
  marker?: string;
  ja: Inline[];
  translation?: Inline[];
  domain?: string;
}

export interface NoteBlock {
  kind: 'note';
  marker: string;
  content: Inline[];
}

export interface ParagraphBlock {
  kind: 'paragraph';
  content: Inline[];
}

export type GlossBlock =
  | HeadwordBlock
  | SenseBlock
  | ExampleBlock
  | SubentryBlock
  | NoteBlock
  | ParagraphBlock;

/* ────────────────────────────── 小工具 ────────────────────────────── */

const IDEOGRAPH = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const KANA_ONLY = /^[\u3041-\u309f\u30a1-\u30ff\u30fc]+$/;
const CJK = /[\u3041-\u309f\u30a1-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]/;

function toHalfDigits(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/**
 * 参见目标 → 查询词。
 * 研究社的参见写法带同音号与义项号：`いい２ 3` / `よい３ 1` / `くう２ 2`，
 * 显示时保留原样，查询时要剥成 `いい` / `よい` / `くう`。
 */
export function xrefQuery(label: string): string {
  let s = label.trim();
  s = s.replace(/[.。,，;；]+$/, '');
  s = s.replace(/[\s\u3000]+[0-9０-９]+$/, ''); // 尾随义项号
  s = s.replace(/[0-9０-９]+$/, ''); // 尾随同音号
  return s.trim();
}

/* ────────────────────────────── 行内解析 ────────────────────────────── */

interface PairDef {
  close: string;
  t: 'domain' | 'field' | 'usage' | 'etym' | 'register';
}

const PAIRS: Record<string, PairDef> = {
  '〔': { close: '〕', t: 'domain' },
  '【': { close: '】', t: 'field' },
  '〈': { close: '〉', t: 'usage' },
  '〚': { close: '〛', t: 'etym' },
  '《': { close: '》', t: 'register' },
};

const OPEN_PAREN = new Set(['(', '（']);
const CLOSE_PAREN = new Set([')', '）']);

/** 从 i（指向开括号）出发找到配对的闭括号；找不到返回 -1 */
function matchParen(src: string, i: number): number {
  let depth = 0;
  for (let k = i; k < src.length; k++) {
    const c = src[k]!;
    if (OPEN_PAREN.has(c)) depth++;
    else if (CLOSE_PAREN.has(c)) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** 参见记号后面的目标串在哪里结束（保持括号平衡） */
function xrefEnd(src: string, from: number): number {
  let depth = 0;
  for (let k = from; k < src.length; k++) {
    const c = src[k]!;
    if (OPEN_PAREN.has(c)) {
      // 「＝ノート(型)パソコン (⇒ノート).」：空格后的括号说明目标已经结束
      if (depth === 0 && k > from && /[\s\u3000]/.test(src[k - 1]!)) return k;
      depth++;
      continue;
    }
    if (CLOSE_PAREN.has(c)) {
      if (depth === 0) return k;
      depth--;
      continue;
    }
    if (depth > 0) continue;
    if (c === '.' || c === '。' || c === ']' || c === '】' || c === '｜' || c === '」' || c === '》') return k;
    // 又开了一组括号（〔2 〔懐具合〕 finances〕）说明参见目标已经结束
    if (c === '〔' || c === '【' || c === '《' || c === '〈' || c === '〚' || c === '「') return k;
  }
  return src.length;
}

/** 在深度 0 处按 `,` `;` 切分多个参见目标 */
function splitTargets(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < raw.length; k++) {
    const c = raw[k]!;
    if (OPEN_PAREN.has(c)) depth++;
    else if (CLOSE_PAREN.has(c)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === ',' || c === ';' || c === '，' || c === '；')) {
      out.push(raw.slice(start, k));
      start = k + 1;
    }
  }
  out.push(raw.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

function pushXrefs(out: Inline[], marker: string, raw: string): void {
  for (const label of splitTargets(raw)) {
    out.push({ t: 'xref', v: label, query: xrefQuery(label), marker });
  }
}

/** `┏` 与 `[` 之间超过这个距离就认为不是可替换记号，退化成普通文本 */
const ALT_MAIN_MAX = 64;
/** `[…]` 里超过这个长度就不当作可替换项 */
const ALT_BODY_MAX = 72;

/**
 * 把一行（或例句的一半）切成 Inline 记号。
 * 单次线性扫描 + indexOf，不做回溯，长文本也安全。
 */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf) {
      out.push({ t: 'text', v: buf });
      buf = '';
    }
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;

    // 〔…〕【…】〈…〉〚…〛《…》
    const pair = PAIRS[ch];
    if (pair) {
      const end = src.indexOf(pair.close, i + 1);
      if (end > i) {
        flush();
        out.push({ t: pair.t, v: src.slice(i + 1, end) } as Inline);
        i = end + 1;
        continue;
      }
    }

    // (…)：注音 / 补充说明 / 内嵌参见
    if (OPEN_PAREN.has(ch)) {
      const end = matchParen(src, i);
      if (end > i) {
        const body = src.slice(i + 1, end);
        const trimmed = body.trim();
        if (trimmed.startsWith('⇒') || trimmed.startsWith('＝')) {
          flush();
          out.push({ t: 'text', v: ch });
          pushXrefs(out, trimmed[0]!, trimmed.slice(1));
          out.push({ t: 'text', v: src[end]! });
          i = end + 1;
          continue;
        }
        // 前接汉字 + 纯假名 → 注音
        const kanjiRun = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$/.exec(buf);
        if (kanjiRun && body.length <= 8 && KANA_ONLY.test(body)) {
          const base = kanjiRun[0];
          buf = buf.slice(0, buf.length - base.length);
          flush();
          out.push({ t: 'ruby', base, rt: body });
          i = end + 1;
          continue;
        }
        if (CJK.test(body) && !IDEOGRAPH.test(buf.slice(-1))) {
          flush();
          out.push({ t: 'gloss-note', v: body });
          i = end + 1;
          continue;
        }
        // 其余（analog(ue)、(a) plastic…）保持原样
        buf += src.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }

    // ┏A [B]
    if (ch === '┏') {
      const open = src.indexOf('[', i + 1);
      const close = open > 0 ? src.indexOf(']', open + 1) : -1;
      if (open > 0 && close > open && open - i <= ALT_MAIN_MAX && close - open <= ALT_BODY_MAX) {
        const main = src.slice(i + 1, open).replace(/[\s\u3000]+$/, '');
        flush();
        out.push({ t: 'alt', main: parseInline(main), alts: splitTargets(src.slice(open + 1, close)) });
        i = close + 1;
        continue;
      }
      i += 1; // 记号本身不显示
      continue;
    }

    // [⇒…] / [＝…] / [B]
    if (ch === '[') {
      const close = src.indexOf(']', i + 1);
      if (close > i) {
        const body = src.slice(i + 1, close).trim();
        if (body.startsWith('⇒') || body.startsWith('＝')) {
          flush();
          pushXrefs(out, body[0]!, body.slice(1));
          i = close + 1;
          continue;
        }
        if (close - i <= ALT_BODY_MAX) {
          flush();
          out.push({ t: 'alt', main: [], alts: splitTargets(body) });
          i = close + 1;
          continue;
        }
      }
    }

    // ⇒xxx / ＝xxx
    if (ch === '⇒' || ch === '＝') {
      const end = xrefEnd(src, i + 1);
      const raw = src.slice(i + 1, end);
      if (raw.trim()) {
        flush();
        pushXrefs(out, ch, raw);
        i = end;
        continue;
      }
    }

    // ｜
    if (ch === '｜') {
      flush();
      out.push({ t: 'sep' });
      i += 1;
      continue;
    }

    // ▶ / ▷ 编者注记：吃掉本段剩余内容
    if (ch === '▶' || ch === '▷') {
      const rest = src.slice(i + 1).trim();
      flush();
      out.push({ t: 'note', v: rest, marker: ch });
      i = n;
      continue;
    }

    // ᐦword（文语）/ *word（美式）
    if (ch === 'ᐦ' || (ch === '*' && !/[A-Za-z0-9]/.test(src[i - 1] ?? ''))) {
      const m = /^[A-Za-z][A-Za-z'’\u2010-\u2015-]*/.exec(src.slice(i + 1));
      if (m) {
        flush();
        out.push({ t: 'mark', v: m[0], flavor: ch === 'ᐦ' ? 'literary' : 'us' });
        i += 1 + m[0].length;
        continue;
      }
    }

    // \10,000 → ¥10,000
    if (ch === '\\' && /[0-9０-９]/.test(src[i + 1] ?? '')) {
      buf += '¥';
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }

  flush();
  return out;
}

/* ────────────────────────────── 分块解析 ────────────────────────────── */

const RE_ROMAJI = /^(.*?)[\s\u3000]*\[ローマ字\]\(([^)]*)\)[\s\u3000]*$/;
const RE_SENSE = /^([0-9０-９]{1,2})(?:[ \t\u3000]+(.*))?$/;
const RE_LEAD_DOMAIN = /^〔([^〕]*)〕[\s\u3000]*(.*)$/;

function parseHeadword(line: string): HeadwordBlock | null {
  const m = RE_ROMAJI.exec(line);
  if (!m) return null;
  const romaji = m[2]!.trim();
  let kana = m[1]!.trim();
  let kanji: string | undefined;
  const km = /^(.*?)【(.*)】$/.exec(kana);
  if (km) {
    kana = km[1]!.trim();
    kanji = km[2]!.trim();
  }
  let homographIndex: string | undefined;
  const hm = /^(.*?)([0-9０-９]+)$/.exec(kana);
  if (hm && hm[1]) {
    kana = hm[1]!;
    homographIndex = toHalfDigits(hm[2]!);
  }
  return {
    kind: 'headword',
    kana,
    ...(kanji ? { kanji } : {}),
    ...(romaji ? { romaji } : {}),
    ...(homographIndex ? { homographIndex } : {}),
  };
}

/** 例句／子见出し行：先剥掉行首 `〔…〕`，再按第一个全角空格拆日／英 */
function splitJaTranslation(body: string): { ja: Inline[]; translation?: Inline[]; domain?: string } {
  let rest = body;
  let domain: string | undefined;
  const dm = RE_LEAD_DOMAIN.exec(rest);
  if (dm) {
    domain = dm[1];
    rest = dm[2]!;
  }
  const p = rest.indexOf('\u3000');
  if (p < 0) {
    return { ja: parseInline(rest.trim()), ...(domain ? { domain } : {}) };
  }
  const ja = rest.slice(0, p).trim();
  const tr = rest.slice(p + 1).trim();
  return {
    ja: parseInline(ja),
    ...(tr ? { translation: parseInline(tr) } : {}),
    ...(domain ? { domain } : {}),
  };
}

/** `〜する arrange for…`：派生形后面用半角空格接英文 */
function splitTilde(body: string): { ja: Inline[]; translation?: Inline[] } {
  const m = /^([^\s\u3000]+)[\s\u3000]+(.*)$/.exec(body);
  if (!m) return { ja: parseInline(body) };
  return { ja: parseInline(m[1]!), translation: parseInline(m[2]!.trim()) };
}

/**
 * 把一条纯文本 glossary 解析成块序列。
 * 顶层结构：`[headword?, sense…, subentry…]`，例句／注记在 sense.children 里。
 */
export function parseGlossText(text: string): GlossBlock[] {
  const out: GlossBlock[] = [];
  if (typeof text !== 'string' || !text) return out;

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let currentSense: SenseBlock | null = null;
  let expectedSense = 1;
  /** 见到 ◧/◨ 之后，后续无记号行都算複合語续行，挂到顶层 */
  let compoundMode = false;
  /** 最近一条 `►` 主例，后续 `・` 子例挂在它下面 */
  let lastPrimary: ExampleBlock | null = null;

  const attach = (b: GlossBlock): void => {
    if (compoundMode) {
      out.push(b);
      return;
    }
    if (!currentSense) {
      currentSense = { kind: 'sense', content: [], children: [] };
      out.push(currentSense);
    }
    currentSense.children.push(b);
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!.trim();
    if (!line) continue;

    // 词头行只可能出现在第一行
    if (idx === 0) {
      const head = parseHeadword(line);
      if (head) {
        out.push(head);
        continue;
      }
    }

    const first = line[0]!;

    // ► 主例 / ・ 子例
    if (first === '►' || first === '▸' || first === '・') {
      const level = first === '・' ? 'sub' : 'primary';
      const ex: ExampleBlock = { kind: 'example', level, ...splitJaTranslation(line.slice(1).trim()), children: [] };
      if (level === 'sub' && lastPrimary) lastPrimary.children.push(ex);
      else {
        attach(ex);
        if (level === 'primary') lastPrimary = ex;
      }
      continue;
    }

    // ◧ ◨ 複合語
    if (first === '◧' || first === '◨') {
      compoundMode = true;
      lastPrimary = null;
      out.push({ kind: 'subentry', marker: first, ...splitJaTranslation(line.slice(1).trim()) });
      continue;
    }

    // ▶ ▷ 编者注记
    if (first === '▶' || first === '▷') {
      attach({ kind: 'note', marker: first, content: parseInline(line.slice(1).trim()) });
      continue;
    }

    // 〒する / 〒な 派生形
    if (first === '〜' || first === '～') {
      lastPrimary = null;
      attach({ kind: 'subentry', marker: '〜', ...splitTilde(line.slice(1).trim()) });
      continue;
    }

    // 义项编号：必须严格等于下一个期望编号，避免把「1991 年…」误判成义项
    const sm = RE_SENSE.exec(line);
    if (sm && toHalfDigits(sm[1]!) === String(expectedSense)) {
      const rest = (sm[2] ?? '').trim();
      const dm = RE_LEAD_DOMAIN.exec(rest);
      const sense: SenseBlock = {
        kind: 'sense',
        number: String(expectedSense),
        ...(dm ? { domain: dm[1] } : {}),
        content: parseInline(dm ? dm[2]!.trim() : rest),
        children: [],
      };
      out.push(sense);
      currentSense = sense;
      lastPrimary = null;
      expectedSense++;
      compoundMode = false;
      continue;
    }

    // 複合語续行：紧跟 ◧/◨ 的无记号行
    if (compoundMode) {
      lastPrimary = null;
      out.push({ kind: 'subentry', ...splitJaTranslation(line) });
      continue;
    }

    // 无记号但含全角空格 → 派生形／子见出し（如「美しく　beautifully」）。
    // 必须已经出现过义项：否则会把「〔日本の(1996-　)〕 the Liberal Party」这种
    // 括号里恰好含全角空格的首段说明误判成子见出し。
    if (currentSense && line.includes('\u3000') && !'〔【《〈〚'.includes(first)) {
      // 子见出し会截断例句组：它后面的 ・ 不再属于之前那条 ►
      lastPrimary = null;
      attach({ kind: 'subentry', ...splitJaTranslation(line) });
      continue;
    }

    // 兜底：第一段无编号说明直接作为隐式义项的正文
    if (!currentSense) {
      const dm = RE_LEAD_DOMAIN.exec(line);
      const sense: SenseBlock = {
        kind: 'sense',
        ...(dm ? { domain: dm[1] } : {}),
        content: parseInline(dm ? dm[2]!.trim() : line),
        children: [],
      };
      out.push(sense);
      currentSense = sense;
      continue;
    }
    lastPrimary = null;
    attach({ kind: 'paragraph', content: parseInline(line) });
  }

  return out;
}

/* ────────────────────────────── 判定与还原 ────────────────────────────── */

/** 这条纯文本释义值不值得走上面那套解析（否则直接 pre-wrap 显示即可） */
export function looksStructured(text: unknown): text is string {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (text.includes('\n')) return true;
  return text.includes('►') || text.includes('┏') || text.includes('[ローマ字]') || text.includes('◧') || text.includes('◨');
}

function inlineToText(items: Inline[]): string {
  let s = '';
  for (const it of items) {
    switch (it.t) {
      case 'text':
        s += it.v;
        break;
      case 'ruby':
        s += `${it.base}(${it.rt})`;
        break;
      case 'domain':
        s += `〔${it.v}〕`;
        break;
      case 'field':
        s += `【${it.v}】`;
        break;
      case 'usage':
        s += `〈${it.v}〉`;
        break;
      case 'etym':
        s += `〚${it.v}〛`;
        break;
      case 'register':
        s += `《${it.v}》`;
        break;
      case 'gloss-note':
        s += `(${it.v})`;
        break;
      case 'alt':
        s += `${inlineToText(it.main)}${it.main.length ? ' ' : ''}[${it.alts.join(', ')}]`;
        break;
      case 'xref':
        s += `${it.marker}${it.v}`;
        break;
      case 'sep':
        s += ' ｜ ';
        break;
      case 'note':
        s += `${it.marker}${it.v}`;
        break;
      case 'mark':
        s += it.v;
        break;
    }
  }
  return s;
}

/** 供「复制」按钮使用：带缩进与换行的可读文本 */
export function blocksToPlainText(blocks: GlossBlock[]): string {
  const out: string[] = [];
  const walk = (list: GlossBlock[], depth: number): void => {
    for (const b of list) {
      const pad = '  '.repeat(depth);
      switch (b.kind) {
        case 'headword':
          out.push(
            [b.kana, b.homographIndex ?? '', b.kanji ? `【${b.kanji}】` : '', b.romaji ? ` (${b.romaji})` : ''].join(''),
          );
          break;
        case 'sense': {
          const head = [b.number ? `${b.number}.` : '', b.domain ? `〔${b.domain}〕` : '', inlineToText(b.content)]
            .filter(Boolean)
            .join(' ');
          if (head) out.push(pad + head);
          walk(b.children, depth + 1);
          break;
        }
        case 'example': {
          const mark = b.level === 'primary' ? '▸ ' : '· ';
          out.push(pad + mark + (b.domain ? `〔${b.domain}〕 ` : '') + inlineToText(b.ja));
          if (b.translation) out.push(pad + '  ' + inlineToText(b.translation));
          if (b.children.length) walk(b.children, depth + 1);
          break;
        }
        case 'subentry':
          out.push(
            pad +
              (b.marker ?? '') +
              (b.domain ? `〔${b.domain}〕 ` : '') +
              inlineToText(b.ja) +
              (b.translation ? `  ${inlineToText(b.translation)}` : ''),
          );
          break;
        case 'note':
          out.push(pad + b.marker + inlineToText(b.content));
          break;
        case 'paragraph':
          out.push(pad + inlineToText(b.content));
          break;
      }
    }
  };
  walk(blocks, 0);
  return out.join('\n');
}

/** 统计例句数量（含子例），供折叠策略判断 */
export function countExamples(blocks: GlossBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    if (b.kind === 'example') n += 1 + countExamples(b.children);
    else if (b.kind === 'sense') n += countExamples(b.children);
  }
  return n;
}
