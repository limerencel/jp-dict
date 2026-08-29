/**
 * 分析引擎自测：npx tsx server/analyze/selftest.ts
 *
 * 不依赖词典模块（缺失时自动降级），只验证形态分析、词单位合并、
 * 活用还原、助词判定与振り仮名对齐。
 */
import { analyze, warmup } from './index.ts';
import { buildFurigana, countMora, splitMora, toRomaji } from '../../shared/kana.ts';
import type { AnalysisResult, Word } from '../../shared/types.ts';

let failures = 0;
let checks = 0;

function ok(cond: boolean, label: string, detail = ''): void {
  checks++;
  if (cond) {
    console.log(`  ✅ ${label}`);
  } else {
    failures++;
    console.log(`  ❌ ${label}${detail ? `  → ${detail}` : ''}`);
  }
}

function eq<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, label, `实际 ${a}，期望 ${e}`);
}

function furiganaText(w: Word): string {
  return w.furigana.map((s) => (s.ruby ? `${s.text}[${s.ruby}]` : s.text)).join('');
}

function dumpWord(w: Word, indent = '    '): void {
  const subs = w.subTokens.map((s) => `${s.surface}${s.role ? `(${s.role})` : ''}`).join(' + ');
  console.log(
    `${indent}#${String(w.id).padStart(2)} [${w.start},${w.end}) ${w.surface}` +
      `  ｜${w.posLabel}｜ 读:${w.reading} 辞書形:${w.lemma}`,
  );
  console.log(`${indent}     ruby: ${furiganaText(w)}`);
  if (w.subTokens.length > 1) console.log(`${indent}     拆解(${w.subTokens.length}): ${subs}`);
  if (w.inflection) {
    console.log(`${indent}     活用: ${w.inflection.form}  [${w.inflection.features.join(', ')}]`);
    console.log(`${indent}     还原: ${w.inflection.steps.join(' ← ')}`);
    console.log(`${indent}     说明: ${w.inflection.notes}`);
  }
  if (w.particle) {
    const p = w.particle;
    console.log(`${indent}     助词: ${p.particle}(${p.romaji}) ${p.categoryLabel} → ${p.sense.label} [${p.sense.key}]`);
    console.log(`${indent}       前: ${p.before ? `${p.before.surface}（${p.before.role}）` : '—'}` +
      `   后: ${p.after ? `${p.after.surface}（${p.after.role}）` : '—'}`);
    console.log(`${indent}       结构: ${p.structureNote}`);
    console.log(`${indent}       依据: ${p.reason ?? '—'}`);
  }
}

function dump(res: AnalysisResult): void {
  for (const w of res.words) {
    if (w.pos === 'whitespace') continue;
    dumpWord(w);
  }
  console.log(`    · stats: ${JSON.stringify(res.stats)}`);
  if (res.warnings.length) console.log(`    · warnings: ${res.warnings.join(' / ')}`);
}

function find(res: AnalysisResult, surface: string): Word | undefined {
  return res.words.find((w) => w.surface === surface);
}

function findParticle(res: AnalysisResult, surface: string, nth = 0): Word | undefined {
  return res.words.filter((w) => w.isParticle && w.surface === surface)[nth];
}

/* ────────────────────────────── kana.ts ────────────────────────────── */

function testKana(): void {
  console.log('\n=== shared/kana.ts ===');
  eq(buildFurigana('食べる', 'たべる'), [{ text: '食', ruby: 'た' }, { text: 'べる' }], "buildFurigana('食べる','たべる')");
  eq(
    buildFurigana('お茶を飲む', 'おちゃをのむ'),
    [{ text: 'お' }, { text: '茶', ruby: 'ちゃ' }, { text: 'を' }, { text: '飲', ruby: 'の' }, { text: 'む' }],
    "buildFurigana('お茶を飲む','おちゃをのむ')",
  );
  eq(buildFurigana('私', 'わたし'), [{ text: '私', ruby: 'わたし' }], "buildFurigana('私','わたし')");
  eq(buildFurigana('言い方', 'いいかた'), [{ text: '言', ruby: 'い' }, { text: 'い' }, { text: '方', ruby: 'かた' }], "buildFurigana('言い方','いいかた')");
  eq(buildFurigana('大人しい', 'おとなしい'), [{ text: '大人', ruby: 'おとな' }, { text: 'しい' }], "buildFurigana('大人しい','おとなしい')");
  eq(buildFurigana('こんにちは', 'こんにちは'), [{ text: 'こんにちは' }], '纯假名不注音');
  eq(buildFurigana('東京', 'とうきょ'), [{ text: '東京', ruby: 'とうきょ' }], '对齐失败时整词一个 ruby');

  eq(countMora('きょう'), 2, "countMora('きょう')");
  eq(countMora('がっこう'), 4, "countMora('がっこう')");
  eq(countMora('せんせい'), 4, "countMora('せんせい')");
  eq(countMora('コーヒー'), 4, "countMora('コーヒー')");
  eq(splitMora('しゃしん'), ['しゃ', 'し', 'ん'], "splitMora('しゃしん')");
  eq(toRomaji('がっこう'), 'gakkou', "toRomaji('がっこう')");
  eq(toRomaji('しんぶん'), 'shimbun', "toRomaji('しんぶん')");
  eq(toRomaji('きょうと'), 'kyouto', "toRomaji('きょうと')");
}

/* ────────────────────────────── 句子测试 ────────────────────────────── */

async function s1(): Promise<void> {
  const text = 'こんにちは。';
  console.log(`\n=== 1. ${text} ===`);
  const res = await analyze(text);
  dump(res);
  eq(res.sentences.length, 1, '一个句子');
  const w = find(res, 'こんにちは');
  ok(!!w, '「こんにちは」是一个词单位');
  eq(w?.posLabel, '感叹词', '词性为感叹词');
  eq(res.words.map((x) => x.surface).join(''), text, '词单位可无损还原原文');
}

async function s2(): Promise<void> {
  const text = '私は毎朝七時に学校へ行きます。';
  console.log(`\n=== 2. ${text} ===`);
  const res = await analyze(text);
  dump(res);

  const wa = findParticle(res, 'は');
  ok(!!wa?.particle, '「は」被识别为助词');
  eq(wa?.particle?.romaji, 'wa', '「は」的罗马字是 wa');
  eq(wa?.particle?.sense.key, 'topic', '「は」判定为主题');
  eq(wa?.particle?.before?.surface, '私', '「は」前接「私」');
  eq(wa?.particle?.after?.surface, '行きます', '「は」后接谓语「行きます」');

  const ni = findParticle(res, 'に');
  eq(ni?.particle?.romaji, 'ni', '「に」的罗马字是 ni');
  eq(ni?.particle?.sense.key, 'time', '「に」判定为时点');
  eq(ni?.particle?.before?.surface, '七時', '「に」前接「七時」');

  const e = findParticle(res, 'へ');
  eq(e?.particle?.romaji, 'e', '「へ」的罗马字是 e');
  eq(e?.particle?.sense.key, 'destination', '「へ」判定为目的地');
  eq(e?.particle?.after?.surface, '行きます', '「へ」后接移动动词');

  const iku = find(res, '行きます');
  ok(!!iku, '「行きます」合并为一个词单位');
  eq(iku?.inflection?.steps, ['行きます', '行く'], '「行きます」还原链');
  eq(iku?.inflection?.form, '敬体', '「行きます」形态名');

  const shichiji = find(res, '七時');
  ok(!!shichiji, '「七時」合并为数量词');
  eq(furiganaText(shichiji!), '七[しち]時[じ]', '「七時」逐字注音');
  eq(res.words.map((x) => x.surface).join(''), text, '词单位可无损还原原文');
}

async function s3(): Promise<void> {
  const text = '先生に本を読ませられなかった。';
  console.log(`\n=== 3. ${text} ===`);
  const res = await analyze(text);
  dump(res);

  const v = find(res, '読ませられなかった');
  ok(!!v, '「読ませられなかった」合并为一个词单位');
  eq(v?.subTokens.length, 5, '内部由 5 个词素构成');
  eq(
    v?.inflection?.steps,
    ['読ませられなかった', '読ませられない', '読ませられる', '読ませる', '読む'],
    '使役被动过去否定的还原链',
  );
  eq(v?.inflection?.features, ['使役被动', '过去否定'], '语法要素');
  eq(v?.inflection?.form, '使役被动·过去否定', '形态名');
  eq(v?.subTokens.map((s) => s.role), [undefined, '使役', '被动', '否定', '过去/完了'], '各词素的作用');

  const ni = findParticle(res, 'に');
  eq(ni?.particle?.sense.key, 'agent', '「に」判定为动作主体（被动的施事）');
  eq(ni?.particle?.before?.surface, '先生', '「に」前接「先生」');

  const o = findParticle(res, 'を');
  eq(o?.particle?.romaji, 'o', '「を」的罗马字是 o');
  eq(o?.particle?.sense.key, 'direct-object', '「を」判定为动作对象');
}

async function s4(): Promise<void> {
  const text = '彼が作ってくれたお弁当はとてもおいしかったです。';
  console.log(`\n=== 4. ${text} ===`);
  const res = await analyze(text);
  dump(res);

  const v = find(res, '作ってくれた');
  ok(!!v, '「作ってくれた」合并为一个词单位（含て形＋授受补助动词）');
  eq(v?.subTokens.map((s) => s.surface), ['作っ', 'て', 'くれ', 'た'], '内部词素');
  eq(v?.subTokens.map((s) => s.role), [undefined, 'て形', '授受（内向）', '过去/完了'], '各词素的作用');
  eq(v?.inflection?.steps, ['作ってくれた', '作ってくれる', '作って', '作る'], '还原链');

  const bento = find(res, 'お弁当');
  ok(!!bento, '「お弁当」合并接头词');
  eq(furiganaText(bento!), 'お弁当[べんとう]', '「お弁当」注音');

  const adj = find(res, 'おいしかったです');
  ok(!!adj, '「おいしかったです」合并为一个词单位');
  eq(adj?.inflection?.steps, ['おいしかったです', 'おいしかった', 'おいしい'], 'い形容词还原链');
  eq(adj?.inflection?.form, '过去·敬体', 'い形容词形态名');

  const ga = findParticle(res, 'が');
  eq(ga?.particle?.sense.key, 'subject', '「が」判定为主语');
  eq(ga?.particle?.after?.surface, '作ってくれた', '「が」后接谓语');

  const wa = findParticle(res, 'は');
  eq(wa?.particle?.sense.key, 'topic', '「は」判定为主题');
  eq(wa?.particle?.before?.surface, 'お弁当', '「は」前接「お弁当」');
  eq(wa?.particle?.after?.surface, 'おいしかったです', '「は」后接谓语');
}

async function s5(): Promise<void> {
  const text = '雨が降っているので、今日は出かけないつもりだ。';
  console.log(`\n=== 5. ${text} ===`);
  const res = await analyze(text);
  dump(res);

  const v = find(res, '降っている');
  ok(!!v, '「降っている」合并为一个词单位');
  eq(v?.subTokens.map((s) => s.role), [undefined, 'て形', '进行/结果状态'], '进行体的内部作用');
  eq(v?.inflection?.steps, ['降っている', '降って', '降る'], '进行体还原链');
  eq(v?.inflection?.form, '进行', '进行体形态名');

  const ga = findParticle(res, 'が');
  eq(ga?.particle?.sense.key, 'phenomenon', '「が」判定为现象描写');

  const node = findParticle(res, 'ので');
  ok(!!node?.particle, '「ので」被识别为接续助词');
  eq(node?.particle?.categoryLabel, '接续助词', '「ので」的分类');
  eq(node?.particle?.sense.key, 'reason', '「ので」判定为原因');

  const wa = findParticle(res, 'は');
  eq(wa?.particle?.sense.key, 'negative-scope', '「は」后接否定谓语，判定为否定的焦点');

  const dekake = find(res, '出かけない');
  eq(dekake?.inflection?.steps, ['出かけない', '出かける'], '否定形还原链');

  const tsumori = find(res, 'つもりだ');
  ok(!!tsumori, '「つもりだ」合并为断定形');
  eq(tsumori?.inflection?.steps, ['つもりだ', 'つもり'], '断定形还原链');
  eq(res.words.map((x) => x.surface).join(''), text, '词单位可无损还原原文');
}

async function s6(): Promise<void> {
  const text = '日本語を勉強するのは楽しいと思います。';
  console.log(`\n=== 6. ${text} ===`);
  const res = await analyze(text);
  dump(res);

  const benkyou = find(res, '勉強する');
  ok(!!benkyou, '「勉強する」合并为サ变动词');
  eq(benkyou?.posLabel, '动词（サ变）', 'サ变词性标签');
  eq(benkyou?.lemma, '勉強する', 'サ变辞書形');
  eq(furiganaText(benkyou!), '勉強[べんきょう]する', 'サ变注音');

  const no = findParticle(res, 'の');
  ok(!!no?.particle, '「の」被识别为助词（准体助词）');
  eq(no?.particle?.sense.key, 'nominalizer', '「の」判定为名词化');

  const wa = findParticle(res, 'は');
  eq(wa?.particle?.sense.key, 'no-wa', '「のは」被识别为复合助词');
  eq(wa?.particle?.before?.surface, '勉強する', '「は」的前接成分越过「の」指向小句');

  const to = findParticle(res, 'と');
  eq(to?.particle?.sense.key, 'quote', '「と」判定为引用');
  eq(to?.particle?.categoryLabel, '引用助词', '「と」的分类');
  eq(to?.particle?.before?.surface, '楽しい', '「と」前接引用内容');
  eq(to?.particle?.after?.surface, '思います', '「と」后接引用动词');

  const omou = find(res, '思います');
  eq(omou?.inflection?.steps, ['思います', '思う'], '敬体还原链');
}

/* ────────────────────────────── 额外健壮性 ────────────────────────────── */

async function extra(): Promise<void> {
  console.log('\n=== 7. 健壮性 ===');
  const messy = '  Hello、  世界。\n\n田中さんは  ABC社で 働いて います。 ';
  const res = await analyze(messy);
  eq(res.words.map((w) => w.surface).join(''), messy, '含空白/拉丁字母的文本可无损还原');
  ok(res.words.every((w) => w.end >= w.start), '所有偏移合法');
  ok(res.stats.ms >= 0, 'stats.ms 已填充');
  for (const w of res.words) {
    if (w.pos === 'whitespace') continue;
    console.log(`    ${w.surface} ｜${w.posLabel}｜ [${w.start},${w.end})`);
  }

  const empty = await analyze('');
  eq(empty.words.length, 0, '空文本返回空结果');

  const long = await analyze('猫が好きです。'.repeat(400));
  ok(long.stats.ms < 8000, `长文本（${long.stats.chars} 字 / ${long.stats.words} 词）耗时 ${long.stats.ms}ms`);
  console.log(`    长文本：${long.stats.chars} 字，${long.stats.sentences} 句，${long.stats.words} 词，${long.stats.ms}ms`);

  const suki = long.words.find((w) => w.isParticle && w.surface === 'が');
  eq(suki?.particle?.sense.key, 'object', '「好きです」前的「が」判定为对象语');
}

/* ────────────────────────────── 入口 ────────────────────────────── */

async function main(): Promise<void> {
  const t = Date.now();
  await warmup();
  console.log(`kuromoji 预热完成（${Date.now() - t}ms）`);

  testKana();
  await s1();
  await s2();
  await s3();
  await s4();
  await s5();
  await s6();
  await extra();

  console.log(`\n────────── ${checks - failures}/${checks} 项通过 ──────────`);
  if (failures > 0) {
    console.log(`${failures} 项失败`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
