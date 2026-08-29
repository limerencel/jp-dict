/**
 * 词典模块自测：现造两部假 Yomitan 词典（format 3 + format 1），走完整导入与查询链路。
 *
 * 运行：npx tsx server/dict/selftest.ts
 * 全程在系统临时目录里进行，不碰项目的 data/dictionaries.db。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';

// 必须在 import 任何会读 config.ts 的模块之前改环境变量
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-dict-selftest-'));
process.env.JP_DATA_DIR = path.join(TMP_ROOT, 'data');
process.env.JP_DICT_DIR = path.join(TMP_ROOT, 'dictionaries');

const { glossaryToText } = await import('../../shared/glossary.ts');
const dict = await import('./index.ts');
const { moraCount, normalizeKey } = await import('./kana.ts');

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  checks++;
  if (ok) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures++;
  console.error(`  ✗ ${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

const json = (value: unknown) => strToU8(JSON.stringify(value));

/* ────────────────────────── 造词典 ────────────────────────── */

const MODERN_TITLE = 'セルフテスト辞書';
const LEGACY_TITLE = 'レガシー辞書';

function buildModernZip(dest: string): void {
  const files: Record<string, Uint8Array> = {
    'index.json': json({
      title: MODERN_TITLE,
      format: 3,
      revision: 'st-1',
      sequenced: true,
      author: 'selftest',
      description: '自测用',
      targetLanguage: 'zh',
    }),
    'tag_bank_1.json': json([
      ['n', 'partOfSpeech', -3, '名詞', 0],
      ['vt', 'partOfSpeech', -3, '他動詞', 0],
      ['常用', 'frequent', 0, '常用漢字', 1],
    ]),
    'term_bank_1.json': json([
      ['食べる', 'たべる', 'v1 vt', 'v1', 10, ['to eat', '吃'], 1, '常用'],
      ['生', 'なま', 'n', '', 5, ['raw; fresh'], 2, ''],
      ['生', 'せい', 'n', '', 3, ['life'], 3, ''],
      [
        'ラーメン',
        '',
        'n',
        null,
        8,
        [
          {
            type: 'structured-content',
            content: [{ tag: 'div', content: '拉面' }, { tag: 'img', path: 'img/ramen.png', width: 4 }],
          },
        ],
        4,
        null,
      ],
    ]),
    'term_bank_2.json': json([['犬', 'いぬ', 'n', '', 7, ['dog', { type: 'text', text: '狗' }], 5, '']]),
    'term_meta_bank_1.json': json([
      ['食べる', 'freq', { reading: 'たべる', frequency: { value: 1234, displayValue: '1234位' } }],
      ['犬', 'freq', 560],
      ['ラーメン', 'freq', '2,500'],
      ['食べる', 'pitch', { reading: 'たべる', pitches: [{ position: 2 }] }],
      ['ラーメン', 'pitch', { reading: 'ラーメン', pitches: [{ position: 1, nasal: 3, devoice: [2] }] }],
      ['生', 'pitch', { reading: 'なま', pitches: [{ position: 1 }] }],
      ['客', 'pitch', { reading: 'きゃく', pitches: [{ position: 1 }] }],
      ['花', 'pitch', { reading: 'はな', pitches: [{ position: 2 }] }],
      ['犬', 'ipa', { reading: 'いぬ', transcriptions: [] }],
    ]),
    'kanji_bank_1.json': json([['犬', 'ケン', 'いぬ', '常用', ['dog', 'canine'], { strokes: '4', grade: '1' }]]),
    'kanji_meta_bank_1.json': json([['犬', 'freq', 812]]),
    'img/ramen.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  };
  fs.writeFileSync(dest, zipSync(files, { level: 6 }));
}

/** 多包了一层目录的词典：规范要求 index.json 在根目录，但流通的词典里很常见 */
function buildNestedZip(dest: string): void {
  fs.writeFileSync(
    dest,
    zipSync({
      'my-dict/': new Uint8Array(0),
      'my-dict/index.json': json({ title: 'ネスト辞書', format: 3, revision: 'n-1' }),
      'my-dict/term_bank_1.json': json([['山', 'やま', '', '', 1, ['mountain'], 1, '']]),
    }),
  );
}

/** 旧版：无 sequence/termTags，释义从第 5 项起平铺；用 store 模式压缩以覆盖另一条解压分支 */
function buildLegacyZip(dest: string): void {
  const files: Record<string, Uint8Array> = {
    'index.json': json({
      title: LEGACY_TITLE,
      version: 1,
      revision: 'legacy-1',
      tagMeta: { n: { category: 'partOfSpeech', order: -3, notes: '名詞（旧）', score: 0 } },
    }),
    'term_bank_1.json': json([
      ['猫', 'ねこ', 'n', '', 4, 'cat', 'ねこ'],
      ['食べる', 'たべる', 'v1', 'v1', 2, 'legacy eat'],
    ]),
    'kanji_bank_1.json': json([['猫', 'ビョウ', 'ねこ', '常用', 'cat', 'feline']]),
  };
  fs.writeFileSync(dest, zipSync(files, { level: 0 }));
}

/* ────────────────────────── 跑测试 ────────────────────────── */

const dictDir = path.join(TMP_ROOT, 'dictionaries');
fs.mkdirSync(dictDir, { recursive: true });
const modernZip = path.join(dictDir, 'selftest-modern.zip');
const legacyZip = path.join(dictDir, 'selftest-legacy.zip');
buildModernZip(modernZip);
buildLegacyZip(legacyZip);

console.log(`临时目录: ${TMP_ROOT}`);

try {
  section('kana 归一化');
  check('片假名→平假名', normalizeKey('ラーメン') === 'らーめん', normalizeKey('ラーメン'));
  check('半角片假名+浊点', normalizeKey('ﾀﾞｲｽｷ') === 'だいすき', normalizeKey('ﾀﾞｲｽｷ'));
  check('全角字母小写化', normalizeKey('ＡＴＭ') === 'atm', normalizeKey('ＡＴＭ'));
  check('拗音算 1 拍', moraCount('きゃく') === 2, moraCount('きゃく'));
  check('长音促音各算 1 拍', moraCount('らーめん') === 4 && moraCount('がっこう') === 4);

  section('导入 format 3 词典');
  const progress: string[] = [];
  const modern = await dict.importDictionaryFile(modernZip, (p) => progress.push(`${p.phase}:${p.message}`));
  check('返回 DictionaryMeta', modern.id > 0 && modern.title === MODERN_TITLE, modern.title);
  check('revision 解析', modern.revision === 'st-1', modern.revision);
  check('format = 3', modern.format === 3, modern.format);
  check('termCount = 5', modern.termCount === 5, modern.termCount);
  check('kanjiCount = 1', modern.kanjiCount === 1, modern.kanjiCount);
  check('metaCount = 10', modern.metaCount === 10, modern.metaCount);
  check('kind = mixed', modern.kind === 'mixed', modern.kind);
  check('进度回调有 done', progress.some((p) => p.startsWith('done:')), progress.length);

  section('导入 format 1 词典');
  const legacy = await dict.importDictionaryFile(legacyZip);
  check('format = 1', legacy.format === 1, legacy.format);
  check('旧版 termCount = 2', legacy.termCount === 2, legacy.termCount);
  check('旧版 kanjiCount = 1', legacy.kanjiCount === 1, legacy.kanjiCount);
  check('旧版 kind = mixed', legacy.kind === 'mixed', legacy.kind);
  check('词典列表 2 部', dict.listDictionaries().length === 2);
  check('isReady', dict.isReady());

  section('lookupTerm');
  const taberu = dict.lookupTerm('食べる');
  check('两部词典都命中', taberu.length === 2, taberu.map((e) => e.dictTitle));
  check('score 高的在前', taberu[0]?.dictTitle === MODERN_TITLE, taberu[0]?.dictTitle);
  check('释义解析', glossaryToText(taberu[0]?.glossary ?? []) === 'to eat；吃', glossaryToText(taberu[0]?.glossary ?? []));
  check('rules 拆分', JSON.stringify(taberu[0]?.rules) === '["v1"]', taberu[0]?.rules);
  const defTags = taberu[0]?.definitionTags ?? [];
  check('definitionTags 按空格拆分', defTags.length === 2 && defTags[0]?.name === 'v1', defTags);
  check('tag_bank 里的标签带上 notes', defTags[1]?.notes === '他動詞' && defTags[1]?.category === 'partOfSpeech', defTags[1]);
  check('tag_bank 未定义的标签退化成裸名', defTags[0]?.notes === '' && defTags[0]?.category === '', defTags[0]);
  check('termTags 带 notes', taberu[0]?.termTags[0]?.notes === '常用漢字', taberu[0]?.termTags);
  check('sequence 保留', taberu[0]?.sequence === 1, taberu[0]?.sequence);

  const byReading = dict.lookupTerm('たべる');
  check('按读音命中', byReading.length === 2, byReading.length);
  const byKatakana = dict.lookupTerm('タベル');
  check('片假名查询归一化命中', byKatakana.length === 2, byKatakana.length);

  const nama = dict.lookupTerm('生', 'なま');
  check('同形异读过滤', nama.length === 1 && nama[0]?.reading === 'なま', nama.map((e) => e.reading));
  const sei = dict.lookupTerm('生', 'せい');
  check('另一读音', sei.length === 1 && sei[0]?.reading === 'せい', sei.map((e) => e.reading));
  check('不给读音时两条都在', dict.lookupTerm('生').length === 2);
  check('读音对不上时退回全量', dict.lookupTerm('生', 'ぜんぶ').length === 2);

  const ramen = dict.lookupTerm('ラーメン');
  check('假名词条无 reading 也能查到', ramen.length === 1, ramen.length);
  check('structured-content 扁平化', glossaryToText(ramen[0]?.glossary ?? []) === '拉面', glossaryToText(ramen[0]?.glossary ?? []));
  check('null 标签不炸', ramen[0]?.termTags.length === 0 && ramen[0]?.rules.length === 0);

  const legacyCat = dict.lookupTerm('猫');
  check('旧版释义平铺', glossaryToText(legacyCat[0]?.glossary ?? []) === 'cat；ねこ', glossaryToText(legacyCat[0]?.glossary ?? []));
  check('旧版 index.tagMeta 生效', legacyCat[0]?.definitionTags[0]?.notes === '名詞（旧）', legacyCat[0]?.definitionTags);
  check('limit 生效', dict.lookupTerm('食べる', undefined, 1).length === 1);
  check('查不到返回空数组', dict.lookupTerm('存在しない語').length === 0);

  section('lookupTermsBatch');
  const batch = dict.lookupTermsBatch([
    { term: '食べる', reading: 'たべる' },
    { term: '生', reading: 'せい' },
    { term: '生' },
    { term: 'ない語' },
  ]);
  check('key 格式', batch.has('食べる\u0000たべる') && batch.has('生\u0000'), [...batch.keys()]);
  check('批量结果与单查一致', batch.get('食べる\u0000たべる')?.length === 2, batch.get('食べる\u0000たべる')?.length);
  check('同 term 不同 reading 互不干扰', batch.get('生\u0000せい')?.length === 1 && batch.get('生\u0000')?.length === 2, [
    batch.get('生\u0000せい')?.length,
    batch.get('生\u0000')?.length,
  ]);
  check('未命中也有 key', batch.get('ない語\u0000')?.length === 0);

  section('lookupPitch');
  const pitchTaberu = dict.lookupPitch('食べる', 'たべる');
  check('たべる 位置 2 → 中高', pitchTaberu[0]?.position === 2 && pitchTaberu[0]?.patternLabel === '中高', pitchTaberu[0]);
  const pitchRamen = dict.lookupPitch('ラーメン');
  check('ラーメン 位置 1 → 頭高', pitchRamen[0]?.patternLabel === '頭高', pitchRamen[0]);
  check('nasal 数字转数组', JSON.stringify(pitchRamen[0]?.nasal) === '[3]', pitchRamen[0]?.nasal);
  check('devoice 保留', JSON.stringify(pitchRamen[0]?.devoice) === '[2]', pitchRamen[0]?.devoice);
  const pitchKyaku = dict.lookupPitch('客');
  check('きゃく（2 拍）位置 1 → 頭高', pitchKyaku[0]?.patternLabel === '頭高', pitchKyaku[0]);
  const pitchHana = dict.lookupPitch('花');
  check('はな（2 拍）位置 2 → 尾高', pitchHana[0]?.patternLabel === '尾高', pitchHana[0]);
  const pitchNama = dict.lookupPitch('生', 'なま');
  check('按读音过滤声调', pitchNama.length === 1 && pitchNama[0]?.reading === 'なま', pitchNama);
  check('无声调数据返回空', dict.lookupPitch('猫').length === 0);

  section('lookupFrequency');
  const freqTaberu = dict.lookupFrequency('食べる', 'たべる');
  check('数值与展示串', freqTaberu[0]?.value === 1234 && freqTaberu[0]?.displayValue === '1234位', freqTaberu[0]);
  const freqInu = dict.lookupFrequency('犬');
  check('裸数字 freq', freqInu.some((f) => f.value === 560), freqInu);
  check('单字顺带取汉字频率', freqInu.some((f) => f.value === 812), freqInu);
  const freqRamen = dict.lookupFrequency('ラーメン');
  check('带逗号的字符串 freq', freqRamen[0]?.value === 2500 && freqRamen[0]?.displayValue === '2,500', freqRamen[0]);
  check('无频率数据返回空', dict.lookupFrequency('猫').length === 0);

  section('lookupKanji');
  const kanji = dict.lookupKanji(['犬', '猫', '龍']);
  check('命中两个汉字', kanji.length === 2, kanji.map((k) => k.character));
  const inu = kanji.find((k) => k.character === '犬');
  check('音読み/訓読み拆分', JSON.stringify(inu?.onyomi) === '["ケン"]' && JSON.stringify(inu?.kunyomi) === '["いぬ"]', [
    inu?.onyomi,
    inu?.kunyomi,
  ]);
  check('meanings', JSON.stringify(inu?.meanings) === '["dog","canine"]', inu?.meanings);
  check('stats', inu?.stats.strokes === '4' && inu?.stats.grade === '1', inu?.stats);
  check('kanji tags 解析', inu?.tags[0]?.notes === '常用漢字', inu?.tags);
  const neko = kanji.find((k) => k.character === '猫');
  check('旧版 kanji meanings 平铺', JSON.stringify(neko?.meanings) === '["cat","feline"]', neko?.meanings);

  section('媒体文件');
  const media = dict.resolveMediaPath(modern.id, 'img/ramen.png');
  check('解包到 MEDIA_DIR', media !== null && fs.existsSync(media), media);
  check('越界路径被拒', dict.resolveMediaPath(modern.id, '../../../etc/passwd') === null);
  check('不存在的媒体返回 null', dict.resolveMediaPath(modern.id, 'img/nope.png') === null);

  section('启用开关与优先级');
  dict.setDictionaryEnabled(legacy.id, false);
  check('停用后查不到', dict.lookupTerm('猫').length === 0);
  check('停用后其他词典仍在', dict.lookupTerm('食べる').length === 1);
  dict.setDictionaryEnabled(legacy.id, true);
  check('重新启用', dict.lookupTerm('猫').length === 1);
  const raised = dict.setDictionaryPriority(legacy.id, 10);
  check('优先级写入', raised?.priority === 10, raised?.priority);
  check('高优先级词典排前面', dict.lookupTerm('食べる')[0]?.dictTitle === LEGACY_TITLE, dict.lookupTerm('食べる')[0]?.dictTitle);
  check('列表按优先级排序', dict.listDictionaries()[0]?.id === legacy.id);
  check('不存在的 id 返回 null', dict.setDictionaryPriority(9999, 1) === null);
  dict.setDictionaryPriority(legacy.id, 0);

  section('重复导入（幂等）');
  dict.setDictionaryPriority(modern.id, 3);
  const again = await dict.importDictionaryFile(modernZip);
  check('词典数量不变', dict.listDictionaries().length === 2, dict.listDictionaries().length);
  check('重导入保持 id', again.id === modern.id, [again.id, modern.id]);
  check('重导入保留优先级', again.priority === 3, again.priority);
  check('词条数不翻倍', again.termCount === 5, again.termCount);
  check('查询结果不重复', dict.lookupTerm('ラーメン').length === 1);
  dict.setDictionaryPriority(modern.id, 0);

  section('scanAndImport');
  const firstScan = await dict.scanAndImport();
  check(
    '已导入的被跳过',
    firstScan.skipped.length === 2 && firstScan.imported.length === 0,
    firstScan,
  );
  const brokenZip = path.join(dictDir, 'broken.zip');
  fs.writeFileSync(brokenZip, zipSync({ 'readme.txt': strToU8('not a dictionary') }));
  const secondScan = await dict.scanAndImport();
  check('坏词典进 failed 而不抛出', secondScan.failed.length === 1 && secondScan.failed[0]?.file === 'broken.zip', secondScan.failed);
  check('坏词典不入库', dict.listDictionaries().length === 2);
  fs.rmSync(brokenZip);

  section('删除词典');
  const mediaDir = path.dirname(media ?? '');
  check('删除成功', dict.deleteDictionary(modern.id));
  check('内容随之消失', dict.lookupTerm('ラーメン').length === 0 && dict.lookupKanji(['犬']).length === 0);
  check('媒体目录被清理', !fs.existsSync(mediaDir));
  check('剩下 1 部词典', dict.listDictionaries().length === 1);
  check('删除不存在的 id 返回 false', dict.deleteDictionary(modern.id) === false);

  section('子目录布局的词典');
  // 放在 dictDir 之外，避免干扰前面的扫描计数
  const nestedZip = path.join(TMP_ROOT, 'nested.zip');
  buildNestedZip(nestedZip);
  const nested = await dict.importDictionaryFile(nestedZip);
  check('识别嵌套的 index.json', nested.title === 'ネスト辞書' && nested.termCount === 1, nested);
  check('嵌套词典可查', dict.lookupTerm('山')[0]?.reading === 'やま', dict.lookupTerm('山'));
  dict.deleteDictionary(nested.id);

  section('重开库');
  dict.closeDictionaries();
  const reopened = dict.listDictionaries();
  check('数据持久化', reopened.length === 1 && reopened[0]?.title === LEGACY_TITLE, reopened.map((d) => d.title));
  check('重开后仍可查询', dict.lookupTerm('猫').length === 1);
} catch (err) {
  failures++;
  console.error('\n未捕获异常：', err);
} finally {
  dict.closeDictionaries();
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? '全部通过' : '存在失败'}：${checks - failures}/${checks}`);
if (failures > 0) process.exitCode = 1;
