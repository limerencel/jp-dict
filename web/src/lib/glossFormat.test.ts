/**
 * glossFormat 的自检脚本（不依赖测试框架，也不 import `@shared/*`）。
 *
 *   npx tsx web/src/lib/glossFormat.test.ts
 *
 * 输入是从 data/dictionaries.db 里导出的「研究社　新和英大辞典　第５版」真实数据。
 */
import {
  blocksToPlainText,
  countExamples,
  looksStructured,
  parseGlossText,
  type ExampleBlock,
  type GlossBlock,
  type Inline,
  type SenseBlock,
  type SubentryBlock,
} from './glossFormat.ts';

// tsconfig.web.json 只引了 vite/client 的类型，这里自己声明 Node 的 process
 declare const process: { exitCode: number } | undefined;

/* ────────────────────────────── 断言工具 ────────────────────────────── */

let pass = 0;
let fail = 0;

function ok(label: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  \u001b[32m✓\u001b[0m ${label}`);
  } else {
    fail++;
    console.log(`  \u001b[31m✗\u001b[0m ${label}`);
    if (extra !== undefined) console.log('      got:', extra);
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  ok(`${label} = ${JSON.stringify(expected)}`, Object.is(actual, expected), actual);
}

/* ────────────────────────────── 真实数据 ────────────────────────────── */

const GAKKOU = [
  'がっこう【学校】 [ローマ字](gakkō)',
  'a school; 〔専門・大学程度の〕 a college; a university; 〔中学以上高等学校程度の〕 an academy; 〔神学などの〕 a seminary; 〔総称的に〕 an educational ┏establishment [institution, organization]; a teaching institution.',
  '►調理師の学校　a cooking school',
  '・通信制の学校　a correspondence school',
  '・キリスト教の精神に基づいた学校　a school based on Christian principles.',
  '►学校から帰る　get [come, go, arrive] home from school; get back from school',
  '・学校指定の　regulation 《footwear》; prescribed 《stationer》; prescribed by school regulations.',
  '►学校が始まる[終わる]　〔その日の〕 school ┏begins [ends]; lessons ┏begin [end]; 〔その学期の〕 (a) term [a semester, school] begins [ends]',
  '・今度の土曜日は学校がある.　There\u0027s school [There are classes] on [this, next] Saturday.',
  '・〔夏期休暇などで〕 学校が休みになる.　School ┏ends [finishes] for the summer vacation. ｜ ᐦSchool breaks up (for the summer holidays).',
  '►学校で　in [ᐦat] school',
].join('\n');

const II = [
  'いい２【良い】 [ローマ字](ii)',
  '1 〔悪・誤・劣・醜・凶に対して善・正・優・美・吉〕 (上等の) good; (優秀な) excellent; (良好な) satisfactory; ... [⇒よい３ 1]',
  '►非常にいい　excellent; superb; outstanding',
  '・いい子　⇒いいこ. ▶その他「いい…」については, それぞれ独立見出しを参照.',
  '►私はいい友人に恵まれている.　I\u0027m blessed with good friends.',
  '・彼女は頭がいい.　She is ┏bright [*smart]. ｜ 《口》 She has a good head on her shoulders.',
  '2 〔適当〕 (適当な) suitable; (効果的な) effective; ... [⇒いい２ 2]',
  '3 〔(「…でよい」 「よかったら」などの形で) 許容・満足〕 [⇒いい２ 3, よし５, よろしい]',
  '4 〔(「…してよい」などの形で) 承認・許可〕 [⇒いい２ 4, よし５]',
].join('\n');

/** 複合語 / 派生形 / 词源 / 日元记号 的杂项样本（同样来自真实词条） */
const MISC = [
  'コンピューター [ローマ字](konpyūtā)',
  '〔電子計算機〕 a computer; an electronic computer.',
  '►コンピューターで計算する　do calculations [《口》 crunch numbers] on a computer',
  '◨アナログ[デジタル]・コンピューター　an analog(ue) [a digital] computer.',
  '大型コンピューター　⇒おおがた.',
  'ノートブック型コンピューター　＝ノート(型)パソコン (⇒ノート).',
].join('\n');

const MONEY = '►500 円プラスして 2500 円ではどうだい.　How about adding \\500 and making it \\2500?';
const RUBY = '►燗(かん)は人肌がいい.　Sake is best when warmed to body temperature.';
const ETYM = '〚＜F〛 〔毒〕 poison.';

/* ────────────────────────────── 辅助 ────────────────────────────── */

function senses(blocks: GlossBlock[]): SenseBlock[] {
  return blocks.filter((b): b is SenseBlock => b.kind === 'sense');
}

/** 主例与子例一并展平 */
function examplesOf(sense: SenseBlock): ExampleBlock[] {
  const out: ExampleBlock[] = [];
  const walk = (list: GlossBlock[]): void => {
    for (const b of list) {
      if (b.kind !== 'example') continue;
      out.push(b);
      walk(b.children);
    }
  };
  walk(sense.children);
  return out;
}

/** 只取一个义项下的主例组 */
function primaryGroups(sense: SenseBlock): ExampleBlock[] {
  return sense.children.filter((b): b is ExampleBlock => b.kind === 'example');
}

function allExamples(blocks: GlossBlock[]): ExampleBlock[] {
  return senses(blocks).flatMap(examplesOf);
}

function flatInline(blocks: GlossBlock[]): Inline[] {
  const out: Inline[] = [];
  const walk = (list: GlossBlock[]): void => {
    for (const b of list) {
      if (b.kind === 'sense') {
        out.push(...b.content);
        walk(b.children);
      } else if (b.kind === 'example') {
        out.push(...b.ja, ...(b.translation ?? []));
        walk(b.children);
      } else if (b.kind === 'subentry') {
        out.push(...b.ja, ...(b.translation ?? []));
      } else if (b.kind === 'note' || b.kind === 'paragraph') {
        out.push(...b.content);
      }
    }
  };
  walk(blocks);
  return out;
}

/** 只保留「内容字符」：丢掉全部排版记号与空白后比较，验证解析不吃字 */
function contentOnly(s: string): string {
  return s
    .replace(/\[ローマ字\]/g, '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[►▸▶▷・·◧◨〜～┏⇒＝｜*ᐦ\[\]（）()〔〕【】〈〉〚〛《》,.;:!?。、，；　\s'"“”‘’\-–—―…]/g, '')
    .replace(/¥/g, '\\');
}

function inlineText(items: Inline[]): string {
  let s = '';
  for (const it of items) {
    if (it.t === 'text') s += it.v;
    else if (it.t === 'ruby') s += it.base + it.rt;
    else if (it.t === 'alt') s += inlineText(it.main) + it.alts.join(', ');
    else if (it.t === 'sep') s += ' ';
    else if (it.t === 'xref' || it.t === 'note' || it.t === 'mark') s += it.v;
    else s += it.v;
  }
  return s;
}

/* ────────────────────────────── 用例 ────────────────────────────── */

console.log('\n\u001b[1m▍学校\u001b[0m');
const gk = parseGlossText(GAKKOU);
{
  const head = gk[0];
  ok('第 1 块是 headword', head?.kind === 'headword');
  if (head?.kind === 'headword') {
    eq('  kana', head.kana, 'がっこう');
    eq('  kanji', head.kanji, '学校');
    eq('  romaji', head.romaji, 'gakkō');
  }

  const ss = senses(gk);
  eq('隐式义项数', ss.length, 1);
  eq('隐式义项无编号', ss[0]?.number, undefined);

  const ex = allExamples(gk);
  eq('例句总数', ex.length, 9);
  eq('主例数（►）', ex.filter((e) => e.level === 'primary').length, 4);
  eq('子例数（・）', ex.filter((e) => e.level === 'sub').length, 5);
  eq('主例组数（・ 嵌套到 ► 下面）', primaryGroups(senses(gk)[0] as SenseBlock).length, 4);
  eq(
    '  第 1 组子例数',
    primaryGroups(senses(gk)[0] as SenseBlock)[0]?.children.length,
    2,
  );
  eq('countExamples 递归计数', countExamples(gk), 9);

  const sat = ex.find((e) => inlineText(e.ja).startsWith('今度の土曜日'));
  ok('找到「今度の土曜日は学校がある.」', !!sat);
  eq('  日文侧', sat ? inlineText(sat.ja) : '', '今度の土曜日は学校がある.');
  eq(
    '  英文侧',
    sat?.translation ? inlineText(sat.translation) : '',
    "There's school There are classes on this, next Saturday.",
  );

  const vac = ex.find((e) => e.domain === '夏期休暇などで');
  ok('例句行首〔夏期休暇などで〕被提为 domain', !!vac);
  const vacAlt = (vac?.translation ?? []).find((i) => i.t === 'alt');
  ok('  译文里 ┏ends [finishes] 解析为 alt', !!vacAlt);
  if (vacAlt && vacAlt.t === 'alt') {
    eq('    main', inlineText(vacAlt.main), 'ends');
    eq('    alts', JSON.stringify(vacAlt.alts), '["finishes"]');
  }
  const lit = (vac?.translation ?? []).find((i) => i.t === 'mark');
  ok('  ᐦSchool 标记为文语', !!lit && lit.t === 'mark' && lit.flavor === 'literary' && lit.v === 'School');

  const domains = senses(gk)[0]?.content.filter((i) => i.t === 'domain') ?? [];
  eq('首段〔…〕数量', domains.length, 4);
}

console.log('\n\u001b[1m▍いい２【良い】\u001b[0m');
const ii = parseGlossText(II);
{
  const head = ii[0];
  if (head?.kind === 'headword') {
    eq('kana', head.kana, 'いい');
    eq('homographIndex', head.homographIndex, '2');
    eq('kanji', head.kanji, '良い');
    eq('romaji', head.romaji, 'ii');
  } else ok('第 1 块是 headword', false, head);

  const ss = senses(ii);
  eq('义项数', ss.length, 4);
  eq('义项编号', ss.map((s) => s.number).join(','), '1,2,3,4');
  eq('义项 2 的 domain', ss[1]?.domain, '適当');
  eq('义项 4 的 domain', ss[3]?.domain, '(「…してよい」などの形で) 承認・許可');

  const x3 = (ss[2]?.content ?? []).filter((i) => i.t === 'xref');
  eq('义项 3 的 xref 数（[⇒いい２ 3, よし５, よろしい]）', x3.length, 3);
  eq(
    '  显示文本',
    x3.map((x) => (x.t === 'xref' ? x.v : '')).join('|'),
    'いい２ 3|よし５|よろしい',
  );
  eq(
    '  查询词（剥掉同音号/义项号）',
    x3.map((x) => (x.t === 'xref' ? x.query : '')).join('|'),
    'いい|よし|よろしい',
  );

  const glossNotes = (ss[0]?.content ?? []).filter((i) => i.t === 'gloss-note');
  eq('义项 1 的 (…) 补充说明数', glossNotes.length, 3);

  const s1 = examplesOf(ss[0] as SenseBlock);
  eq('义项 1 例句数', s1.length, 4);
  eq('义项 1 主例组数', primaryGroups(ss[0] as SenseBlock).length, 2);
  const noteEx = s1.find((e) => (e.translation ?? []).some((i) => i.t === 'note'));
  ok('「・いい子　⇒いいこ. ▶…」里的 ▶ 解析为 note', !!noteEx);
  const xrefEx = (noteEx?.translation ?? []).find((i) => i.t === 'xref');
  ok('  同一行的 ⇒いいこ 解析为 xref', !!xrefEx && xrefEx.t === 'xref' && xrefEx.query === 'いいこ');

  const usMark = s1
    .flatMap((e) => e.translation ?? [])
    .flatMap((i) => (i.t === 'alt' ? i.alts : []))
    .find((a) => a.includes('smart'));
  ok('┏bright [*smart] 的备选被抓到', usMark === '*smart', usMark);
}

console.log('\n\u001b[1m▍複合語 / 派生形 / 参见\u001b[0m');
const mc = parseGlossText(MISC);
{
  const head = mc[0];
  if (head?.kind === 'headword') {
    eq('无汉字词头 kana', head.kana, 'コンピューター');
    eq('无汉字词头 kanji', head.kanji, undefined);
  } else ok('第 1 块是 headword', false, head);

  const subs = mc.filter((b): b is SubentryBlock => b.kind === 'subentry');
  eq('◨ 及其续行都成为 subentry', subs.length, 3);
  eq('  第 1 条 marker', subs[0]?.marker, '◨');
  eq('  第 2 条日文侧', subs[1] ? inlineText(subs[1].ja) : '', '大型コンピューター');
  const x = (subs[1]?.translation ?? []).find((i) => i.t === 'xref');
  ok('  第 2 条译文侧是 ⇒おおがた', !!x && x.t === 'xref' && x.query === 'おおがた');
  const x2 = (subs[2]?.translation ?? []).filter((i) => i.t === 'xref');
  eq('  第 3 条「＝ノート(型)パソコン (⇒ノート).」的 xref 数', x2.length, 2);
  eq('    ＝ 目标', x2[0] && x2[0].t === 'xref' ? x2[0].v : '', 'ノート(型)パソコン');
  eq('    ⇒ 目标', x2[1] && x2[1].t === 'xref' ? x2[1].v : '', 'ノート');
}

console.log('\n\u001b[1m▍杂项记号\u001b[0m');
{
  const money = parseGlossText(MONEY);
  const tr = allExamples(money)[0]?.translation ?? [];
  ok('反斜杠转成 ¥', inlineText(tr).includes('¥500') && inlineText(tr).includes('¥2500'), inlineText(tr));

  const ruby = parseGlossText(RUBY);
  const rb = (allExamples(ruby)[0]?.ja ?? []).find((i) => i.t === 'ruby');
  ok('燗(かん) 解析为 ruby', !!rb && rb.t === 'ruby' && rb.base === '燗' && rb.rt === 'かん');

  const etym = parseGlossText(ETYM);
  const inl = senses(etym)[0]?.content ?? [];
  ok('〚＜F〛 解析为 etym', inl.some((i) => i.t === 'etym' && i.v === '＜F'));
  ok('〔毒〕 解析为 domain', inl.some((i) => i.t === 'domain' && i.v === '毒'));

  ok('looksStructured(学校) === true', looksStructured(GAKKOU));
  ok('looksStructured("school; academy") === false', !looksStructured('school; academy'));
  ok('looksStructured(null) === false', !looksStructured(null));
  ok('looksStructured("") === false', !looksStructured(''));
}

console.log('\n\u001b[1m▍文本无损（记号可丢，内容不可丢）\u001b[0m');
for (const [name, src] of [
  ['学校', GAKKOU],
  ['いい２', II],
  ['コンピューター', MISC],
  ['金额', MONEY],
  ['注音', RUBY],
] as const) {
  const round = blocksToPlainText(parseGlossText(src));
  const a = contentOnly(src);
  const b = contentOnly(round);
  ok(`${name}：AST 还原文本 ≈ 原文（${a.length} 字）`, a === b);
  if (a !== b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        const from = Math.max(0, i - 20);
        console.log('      首个差异 @', i, JSON.stringify(a.slice(from, i + 30)), '≠', JSON.stringify(b.slice(from, i + 30)));
        break;
      }
    }
  }
}

console.log('\n\u001b[1m▍幂等性与性能\u001b[0m');
{
  const once = JSON.stringify(parseGlossText(GAKKOU));
  const twice = JSON.stringify(parseGlossText(GAKKOU));
  ok('同一输入解析结果稳定', once === twice);

  const big = Array.from({ length: 400 }, () => II).join('\n');
  const t0 = Date.now();
  const blocks = parseGlossText(big);
  const ms = Date.now() - t0;
  ok(`${big.length} 字符解析耗时 ${ms}ms < 500ms`, ms < 500);
  console.log(`      → ${blocks.length} 个顶层块，${countExamples(blocks)} 条例句`);
}

console.log('\n\u001b[1m▍排版预览（复制按钮拿到的文本）\u001b[0m');
console.log(
  blocksToPlainText(gk)
    .split('\n')
    .map((l) => '    │ ' + l)
    .join('\n'),
);

console.log(`\n${fail === 0 ? '\u001b[32m' : '\u001b[31m'}${pass} passed, ${fail} failed\u001b[0m\n`);
if (fail > 0 && typeof process !== 'undefined') process.exitCode = 1;
