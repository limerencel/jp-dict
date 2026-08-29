/**
 * 演示数据：后端未就绪时用来自测渲染。
 * 覆盖 は/に/へ/を 助词、使役受身过去否定的还原链、多 subToken 单位、
 * structured-content 释义、声调与频率。
 */
import type {
  AnalysisResult,
  DictEntry,
  KanjiEntry,
  LookupRequest,
  LookupResponse,
  PitchAccent,
  Pos,
  SubToken,
  Word,
} from '@shared/types';
import { buildFurigana } from '@shared/kana';

export const MOCK_TEXT = '私は毎朝七時に学校へ行きます。先生に本を読ませられなかった。';

const POS_LABEL: Partial<Record<Pos, string>> = {
  noun: '名词',
  pronoun: '代词',
  verb: '动词',
  particle: '助词',
  symbol: '符号',
};

interface WordSeed extends Partial<Word> {
  surface: string;
  reading: string;
  pos: Pos;
  sentenceIndex: number;
}

function sub(
  surface: string,
  reading: string,
  posJa: string,
  extra: Partial<SubToken> = {},
): SubToken {
  return {
    surface,
    reading,
    lemma: extra.lemma ?? surface,
    posJa,
    posDetail: extra.posDetail ?? [],
    conjType: extra.conjType ?? '',
    conjForm: extra.conjForm ?? '',
    role: extra.role,
  };
}

function pitch(reading: string, position: number, patternLabel: string): PitchAccent {
  return { dictTitle: 'NHK日本語発音アクセント辞典', reading, position, patternLabel };
}

let cursor = 0;
let idSeq = 0;

function mk(seed: WordSeed): Word {
  const start = cursor;
  cursor += [...seed.surface].length;
  const lemma = seed.lemma ?? seed.surface;
  return {
    id: idSeq++,
    sentenceIndex: seed.sentenceIndex,
    start,
    end: cursor,
    surface: seed.surface,
    reading: seed.reading,
    furigana: seed.furigana ?? buildFurigana(seed.surface, seed.reading),
    lemma,
    lemmaReading: seed.lemmaReading ?? seed.reading,
    pos: seed.pos,
    posLabel: seed.posLabel ?? POS_LABEL[seed.pos] ?? '其他',
    posJa: seed.posJa ?? '名詞',
    isParticle: seed.isParticle ?? seed.pos === 'particle',
    subTokens: seed.subTokens ?? [sub(seed.surface, seed.reading, seed.posJa ?? '名詞', { lemma })],
    inflection: seed.inflection,
    particle: seed.particle,
    brief: seed.brief ?? [],
    hasMore: seed.hasMore ?? false,
    pitch: seed.pitch ?? [],
    frequency: seed.frequency ?? [],
    unknown: seed.unknown ?? false,
  };
}

function buildWords(): Word[] {
  cursor = 0;
  idSeq = 0;

  return [
    /* ── 第 1 句：私は毎朝七時に学校へ行きます。 ── */
    mk({
      sentenceIndex: 0,
      surface: '私',
      reading: 'わたし',
      pos: 'pronoun',
      posJa: '名詞',
      pitch: [pitch('わたし', 0, '平板型')],
      frequency: [{ dictTitle: 'JPDB', value: 12, displayValue: '12' }],
      brief: [
        { dictTitle: '明鏡国語辞典', term: '私', reading: 'わたし', tags: ['代'], text: '自称の人称代名詞。我；我。' },
        { dictTitle: 'JMdict', term: '私', reading: 'わたし', tags: ['pn'], text: 'I; me' },
      ],
      hasMore: true,
    }),
    mk({
      sentenceIndex: 0,
      surface: 'は',
      reading: 'は',
      pos: 'particle',
      posJa: '助詞',
      posLabel: '助词（係助詞）',
      particle: {
        particle: 'は',
        romaji: 'wa',
        category: 'binding',
        categoryLabel: '係助詞',
        sense: {
          key: 'topic',
          label: '提示主题',
          detail: '把前面的成分提出来作为整句谈论的话题，后面是关于它的陈述。读作 wa。',
          example: '私は学生です。',
          exampleTranslation: '我是学生。',
        },
        allSenses: [
          {
            key: 'topic',
            label: '提示主题',
            detail: '把前面的成分提出来作为整句谈论的话题。',
            example: '私は学生です。',
            exampleTranslation: '我是学生。',
          },
          {
            key: 'contrast',
            label: '对比',
            detail: '暗示与其他事物的对照，常成对出现。',
            example: '肉は食べるが、魚は食べない。',
            exampleTranslation: '肉我吃，鱼不吃。',
          },
          {
            key: 'emphasis-negative',
            label: '加强否定',
            detail: '与否定呼应，强调「至少不是这个」。',
            example: 'そう簡単には行かない。',
            exampleTranslation: '没那么容易。',
          },
        ],
        before: { wordId: 0, surface: '私', role: '主题' },
        after: { wordId: 7, surface: '行きます', role: '谓语' },
        structureNote: '「私 は … 行きます」：私 是话题，行きます 是对该话题的陈述。',
        reason: '位于句首名词之后、且全句只有一个 は，判定为主题提示而非对比。',
      },
    }),
    mk({
      sentenceIndex: 0,
      surface: '毎朝',
      reading: 'まいあさ',
      pos: 'noun',
      posLabel: '名词（时间）',
      pitch: [pitch('まいあさ', 1, '頭高型')],
      brief: [{ dictTitle: '明鏡国語辞典', term: '毎朝', reading: 'まいあさ', tags: ['名'], text: '每天早上。' }],
    }),
    mk({
      sentenceIndex: 0,
      surface: '七時',
      reading: 'しちじ',
      pos: 'number',
      posLabel: '数词 + 量词',
      posJa: '名詞',
      subTokens: [
        sub('七', 'しち', '名詞', { posDetail: ['数'], role: '数词' }),
        sub('時', 'じ', '名詞', { posDetail: ['接尾', '助数詞'], role: '时刻量词' }),
      ],
      pitch: [pitch('しちじ', 1, '頭高型')],
      brief: [{ dictTitle: '明鏡国語辞典', term: '七時', reading: 'しちじ', tags: [], text: '七点钟。' }],
    }),
    mk({
      sentenceIndex: 0,
      surface: 'に',
      reading: 'に',
      pos: 'particle',
      posJa: '助詞',
      posLabel: '助词（格助詞）',
      particle: {
        particle: 'に',
        romaji: 'ni',
        category: 'case',
        categoryLabel: '格助詞',
        sense: {
          key: 'time-point',
          label: '时间点',
          detail: '标示动作发生的具体时刻。可与数字时间、星期、日期搭配。',
          example: '七時に起きる。',
          exampleTranslation: '七点起床。',
        },
        allSenses: [
          { key: 'time-point', label: '时间点', detail: '标示动作发生的具体时刻。', example: '七時に起きる。', exampleTranslation: '七点起床。' },
          { key: 'location-exist', label: '存在地点', detail: '与 ある / いる 搭配，表示存在的场所。', example: '机の上に本がある。', exampleTranslation: '桌上有书。' },
          { key: 'direction', label: '归着点', detail: '动作到达的终点，与 へ 相比更强调「到达」。', example: '学校に行く。', exampleTranslation: '去学校。' },
          { key: 'agent', label: '动作主体', detail: '被动、使役句中动作的实施者。', example: '先生に叱られた。', exampleTranslation: '被老师训了。' },
          { key: 'purpose', label: '目的', detail: '接动词连用形，表示前往的目的。', example: '買い物に行く。', exampleTranslation: '去买东西。' },
        ],
        before: { wordId: 3, surface: '七時', role: '时刻' },
        after: { wordId: 7, surface: '行きます', role: '谓语' },
        structureNote: '「七時 に 行きます」：に 把 七時 固定为动作发生的时间点。',
        reason: '前接成分是可数的时刻名词，后接移动动词，取「时间点」义。',
      },
    }),
    mk({
      sentenceIndex: 0,
      surface: '学校',
      reading: 'がっこう',
      pos: 'noun',
      pitch: [pitch('がっこう', 0, '平板型')],
      frequency: [{ dictTitle: 'BCCWJ', value: 486, displayValue: '486' }],
      brief: [
        { dictTitle: '明鏡国語辞典', term: '学校', reading: 'がっこう', tags: ['名'], text: '一定の目的のもとに教育を行う施設。学校。' },
        { dictTitle: 'JMdict', term: '学校', reading: 'がっこう', tags: ['n'], text: 'school' },
      ],
      hasMore: true,
    }),
    mk({
      sentenceIndex: 0,
      surface: 'へ',
      reading: 'へ',
      pos: 'particle',
      posJa: '助詞',
      posLabel: '助词（格助詞）',
      particle: {
        particle: 'へ',
        romaji: 'e',
        category: 'case',
        categoryLabel: '格助詞',
        sense: {
          key: 'direction',
          label: '移动方向',
          detail: '标示移动的方向。与 に 相比更强调「朝着」的过程而非到达结果。读作 e。',
          example: '学校へ行く。',
          exampleTranslation: '往学校去。',
        },
        allSenses: [
          { key: 'direction', label: '移动方向', detail: '标示移动的方向。', example: '学校へ行く。', exampleTranslation: '往学校去。' },
          { key: 'recipient', label: '动作对象', detail: '书信、传达类动作的接受方。', example: '母への手紙。', exampleTranslation: '给母亲的信。' },
        ],
        before: { wordId: 5, surface: '学校', role: '方向' },
        after: { wordId: 7, surface: '行きます', role: '移动动词' },
        structureNote: '「学校 へ 行きます」：へ 指出移动朝向的目标。',
        reason: '前接场所名词、后接移动动词 行く，取「移动方向」义。',
      },
    }),
    mk({
      sentenceIndex: 0,
      surface: '行きます',
      reading: 'いきます',
      lemma: '行く',
      lemmaReading: 'いく',
      pos: 'verb',
      posJa: '動詞',
      posLabel: '动词（五段・カ行）',
      subTokens: [
        sub('行き', 'いき', '動詞', { lemma: '行く', posDetail: ['自立'], conjType: '五段・カ行促音便', conjForm: '連用形', role: '连用形' }),
        sub('ます', 'ます', '助動詞', { lemma: 'ます', conjType: '特殊・マス', conjForm: '基本形', role: '敬体' }),
      ],
      inflection: {
        form: '现在肯定・敬体',
        steps: ['行きます', '行く'],
        notes: '五段动词「行く」连用形「行き」＋丁宁助动词「ます」，构成敬体的非过去肯定形。',
        features: ['敬体', '非过去', '肯定'],
      },
      pitch: [pitch('いく', 0, '平板型')],
      frequency: [{ dictTitle: 'JPDB', value: 88, displayValue: '88' }],
      brief: [
        { dictTitle: '明鏡国語辞典', term: '行く', reading: 'いく', tags: ['自五'], text: 'ある場所から他の場所へ移動する。去；前往。' },
        { dictTitle: 'JMdict', term: '行く', reading: 'いく', tags: ['v5k-s', 'vi'], text: 'to go; to move towards' },
      ],
      hasMore: true,
    }),
    mk({ sentenceIndex: 0, surface: '。', reading: '。', pos: 'symbol', posJa: '記号', posLabel: '句号' }),

    /* ── 第 2 句：先生に本を読ませられなかった。 ── */
    mk({
      sentenceIndex: 1,
      surface: '先生',
      reading: 'せんせい',
      pos: 'noun',
      pitch: [pitch('せんせい', 3, '中高型')],
      frequency: [{ dictTitle: 'BCCWJ', value: 271, displayValue: '271' }],
      brief: [
        { dictTitle: '明鏡国語辞典', term: '先生', reading: 'せんせい', tags: ['名'], text: '学問・技芸などを教える人。老师；先生。' },
      ],
      hasMore: true,
    }),
    mk({
      sentenceIndex: 1,
      surface: 'に',
      reading: 'に',
      pos: 'particle',
      posJa: '助詞',
      posLabel: '助词（格助詞）',
      particle: {
        particle: 'に',
        romaji: 'ni',
        category: 'case',
        categoryLabel: '格助詞',
        sense: {
          key: 'agent',
          label: '动作主体（使役／被动）',
          detail: '在被动、使役被动句中标示真正实施动作、或下达指令的一方。',
          example: '母に叱られた。',
          exampleTranslation: '被母亲训了。',
        },
        allSenses: [
          { key: 'time-point', label: '时间点', detail: '标示动作发生的具体时刻。', example: '七時に起きる。', exampleTranslation: '七点起床。' },
          { key: 'location-exist', label: '存在地点', detail: '与 ある / いる 搭配，表示存在的场所。', example: '机の上に本がある。', exampleTranslation: '桌上有书。' },
          { key: 'direction', label: '归着点', detail: '动作到达的终点。', example: '学校に行く。', exampleTranslation: '去学校。' },
          { key: 'agent', label: '动作主体（使役／被动）', detail: '标示实施动作或下达指令的一方。', example: '母に叱られた。', exampleTranslation: '被母亲训了。' },
          { key: 'purpose', label: '目的', detail: '接动词连用形，表示前往的目的。', example: '買い物に行く。', exampleTranslation: '去买东西。' },
        ],
        before: { wordId: 9, surface: '先生', role: '施动者' },
        after: { wordId: 13, surface: '読ませられなかった', role: '使役受身谓语' },
        structureNote: '「先生 に … 読ませられなかった」：先生 是强迫「我」去读的一方，主语（我）被省略。',
        reason: '谓语带使役受身形，に 前的有情名词判定为施加使役的一方。',
      },
    }),
    mk({
      sentenceIndex: 1,
      surface: '本',
      reading: 'ほん',
      pos: 'noun',
      pitch: [pitch('ほん', 1, '頭高型')],
      frequency: [{ dictTitle: 'JPDB', value: 154, displayValue: '154' }],
      brief: [
        { dictTitle: '明鏡国語辞典', term: '本', reading: 'ほん', tags: ['名'], text: '書物。書籍。书。' },
        { dictTitle: 'JMdict', term: '本', reading: 'ほん', tags: ['n'], text: 'book; volume' },
      ],
      hasMore: true,
    }),
    mk({
      sentenceIndex: 1,
      surface: 'を',
      reading: 'を',
      pos: 'particle',
      posJa: '助詞',
      posLabel: '助词（格助詞）',
      particle: {
        particle: 'を',
        romaji: 'o',
        category: 'case',
        categoryLabel: '格助詞',
        sense: {
          key: 'object',
          label: '动作对象',
          detail: '标示他动词动作直接作用的对象。读作 o。',
          example: 'パンを食べる。',
          exampleTranslation: '吃面包。',
        },
        allSenses: [
          { key: 'object', label: '动作对象', detail: '标示他动词动作直接作用的对象。', example: 'パンを食べる。', exampleTranslation: '吃面包。' },
          { key: 'path', label: '经过场所', detail: '与移动动词搭配，表示经过、通过的路径。', example: '公園を歩く。', exampleTranslation: '在公园里走。' },
          { key: 'departure', label: '离开的起点', detail: '与 出る / 降りる 等搭配。', example: '家を出る。', exampleTranslation: '出门。' },
        ],
        before: { wordId: 11, surface: '本', role: '动作对象' },
        after: { wordId: 13, surface: '読ませられなかった', role: '他动词谓语' },
        structureNote: '「本 を 読ませられなかった」：本 是「読む」这个动作的直接对象。',
        reason: '后接他动词 読む 的活用形，取「动作对象」义。',
      },
    }),
    mk({
      sentenceIndex: 1,
      surface: '読ませられなかった',
      reading: 'よませられなかった',
      lemma: '読む',
      lemmaReading: 'よむ',
      pos: 'verb',
      posJa: '動詞',
      posLabel: '动词（五段・マ行）',
      subTokens: [
        sub('読ま', 'よま', '動詞', { lemma: '読む', posDetail: ['自立'], conjType: '五段・マ行', conjForm: '未然形', role: '词干（未然形）' }),
        sub('せ', 'せ', '助動詞', { lemma: 'せる', conjType: '下一段', conjForm: '未然形', role: '使役' }),
        sub('られ', 'られ', '助動詞', { lemma: 'られる', conjType: '一段', conjForm: '連用形', role: '受身' }),
        sub('なかっ', 'なかっ', '助動詞', { lemma: 'ない', conjType: '形容詞・アウオ段', conjForm: '連用タ接続', role: '否定' }),
        sub('た', 'た', '助動詞', { lemma: 'た', conjType: '特殊・タ', conjForm: '基本形', role: '过去' }),
      ],
      inflection: {
        form: '使役受身・过去否定・常体',
        steps: ['読ませられなかった', '読ませられない', '読ませられる', '読ませる', '読む'],
        notes:
          '「読む」→ 使役「読ませる」→ 再加受身「読ませられる」，构成「被迫去读」。再取否定「読ませられない」，最后变过去「読ませられなかった」，即「（当时）没有被迫读」。',
        features: ['使役', '受身', '否定', '过去'],
      },
      pitch: [pitch('よむ', 1, '頭高型')],
      frequency: [{ dictTitle: 'JPDB', value: 320, displayValue: '320' }],
      brief: [
        { dictTitle: '明鏡国語辞典', term: '読む', reading: 'よむ', tags: ['他五'], text: '文字を目で追って意味をとる。读；阅读。' },
        { dictTitle: 'JMdict', term: '読む', reading: 'よむ', tags: ['v5m', 'vt'], text: 'to read' },
      ],
      hasMore: true,
    }),
    mk({ sentenceIndex: 1, surface: '。', reading: '。', pos: 'symbol', posJa: '記号', posLabel: '句号' }),
  ];
}

export function mockAnalysis(): AnalysisResult {
  const words = buildWords();
  const s0 = words.filter((w) => w.sentenceIndex === 0);
  const s1 = words.filter((w) => w.sentenceIndex === 1);
  const seg = (list: Word[]): { start: number; end: number } => ({
    start: list.length ? list[0].start : 0,
    end: list.length ? list[list.length - 1].end : 0,
  });
  const a = seg(s0);
  const b = seg(s1);

  return {
    text: MOCK_TEXT,
    sentences: [
      { index: 0, start: a.start, end: a.end, text: MOCK_TEXT.slice(a.start, a.end), wordIds: s0.map((w) => w.id) },
      { index: 1, start: b.start, end: b.end, text: MOCK_TEXT.slice(b.start, b.end), wordIds: s1.map((w) => w.id) },
    ],
    words,
    dictionaries: [
      { id: 1, title: '明鏡国語辞典', kind: 'term', priority: 100 },
      { id: 2, title: 'JMdict', kind: 'term', priority: 50 },
      { id: 3, title: 'NHK日本語発音アクセント辞典', kind: 'pitch', priority: 10 },
    ],
    stats: {
      chars: [...MOCK_TEXT].length,
      words: words.length,
      sentences: 2,
      unknownWords: 0,
      ms: 42,
    },
    warnings: ['当前展示的是内置演示数据，未连接后端。'],
  };
}

/* ────────────────────────────── 演示用词典查询 ────────────────────────────── */

const MEIKYO_SC: DictEntry = {
  dictId: 1,
  dictTitle: '明鏡国語辞典',
  dictPriority: 100,
  term: '読む',
  reading: 'よむ',
  definitionTags: [
    { name: '他五', category: 'partOfSpeech', order: 1, notes: '他動詞・五段活用', score: 0 },
    { name: '常用', category: 'popular', order: 2, notes: '常用語', score: 0 },
  ],
  termTags: [{ name: '★', category: 'frequent', order: 0, notes: '高頻度語', score: 0 }],
  rules: ['v5'],
  score: 10,
  sequence: 1001,
  matchedVia: ['読ませられなかった', '読ませられない', '読ませられる', '読ませる', '読む'],
  matchedLength: 9,
  glossary: [
    {
      type: 'structured-content',
      content: {
        tag: 'div',
        data: { content: 'entry' },
        content: [
          {
            tag: 'div',
            style: { fontSize: '1.1em', fontWeight: 'bold', marginBottom: 4 },
            content: [
              { tag: 'ruby', content: ['読', { tag: 'rp', content: '(' }, { tag: 'rt', content: 'よ' }, { tag: 'rp', content: ')' }] },
              'む',
            ],
          },
          {
            tag: 'ol',
            content: [
              {
                tag: 'li',
                content: [
                  '書かれた文字を目で追って、その意味を理解する。',
                  { tag: 'br' },
                  {
                    tag: 'span',
                    data: { content: 'example-sentence' },
                    content: '新聞を読む／小説を読む',
                  },
                ],
              },
              {
                tag: 'li',
                content: [
                  '声に出して唱える。',
                  { tag: 'span', data: { content: 'tags' }, style: { marginLeft: 6 }, content: '〔やや古風〕' },
                ],
              },
              {
                tag: 'li',
                content: [
                  '表面に現れない事情や心中を推し量る。',
                  { tag: 'br' },
                  { tag: 'span', data: { content: 'example-sentence' }, content: '相手の手を読む／場の空気を読む' },
                ],
              },
            ],
          },
          {
            tag: 'table',
            style: { marginTop: 6 },
            content: [
              {
                tag: 'thead',
                content: { tag: 'tr', content: [{ tag: 'th', content: '活用形' }, { tag: 'th', content: '例' }] },
              },
              {
                tag: 'tbody',
                content: [
                  { tag: 'tr', content: [{ tag: 'td', content: '未然' }, { tag: 'td', content: '読ま・読も' }] },
                  { tag: 'tr', content: [{ tag: 'td', content: '連用' }, { tag: 'td', content: '読み・読ん' }] },
                  { tag: 'tr', content: [{ tag: 'td', colSpan: 2, style: { textAlign: 'center', color: '#888' }, content: '五段・マ行' }] },
                ],
              },
            ],
          },
          {
            tag: 'div',
            style: { marginTop: 6, fontSize: '0.9em' },
            content: ['関連語：', { tag: 'a', href: '?query=読書', content: '読書' }, '／', { tag: 'a', href: '?query=朗読', content: '朗読' }],
          },
          {
            tag: 'details',
            content: [
              { tag: 'summary', content: '筆順図（演示：图片来自后端 /api/media）' },
              { tag: 'img', path: 'stroke/読.png', width: 120, height: 120, alt: '読 筆順', title: '読 の筆順' },
            ],
          },
        ],
      },
    },
  ],
};

const JMDICT_SIMPLE: DictEntry = {
  dictId: 2,
  dictTitle: 'JMdict',
  dictPriority: 50,
  term: '読む',
  reading: 'よむ',
  definitionTags: [
    { name: 'v5m', category: 'partOfSpeech', order: 1, notes: 'Godan verb with mu ending', score: 0 },
    { name: 'vt', category: 'partOfSpeech', order: 2, notes: 'transitive verb', score: 0 },
  ],
  termTags: [{ name: 'ichi1', category: 'popular', order: 0, notes: 'ichimango goi bunruishuu', score: 0 }],
  rules: ['v5'],
  score: 5,
  sequence: 2002,
  glossary: ['to read', 'to recite (e.g. a sutra); to chant', 'to guess; to predict; to read (someone\u2019s thoughts)'],
};

const MOCK_KANJI: KanjiEntry[] = [
  {
    dictId: 4,
    dictTitle: 'KANJIDIC',
    character: '読',
    onyomi: ['ドク', 'トク', 'トウ'],
    kunyomi: ['よ.む', '-よ.み'],
    tags: [{ name: '常用', category: 'popular', order: 0, notes: '常用漢字', score: 0 }],
    meanings: ['read', '读，阅读'],
    stats: { strokes: '14', grade: '2', jlpt: 'N4', freq: '271' },
  },
];

/** 演示模式下的查词：只对示例里的词返回内容，其余返回空结果 */
export function mockLookup(req: LookupRequest): LookupResponse {
  const key = req.lemma || req.surface;
  const isYomu = key === '読む' || req.surface.startsWith('読');
  return {
    query: key,
    entries: isYomu ? [MEIKYO_SC, JMDICT_SIMPLE] : [],
    kanji: isYomu ? MOCK_KANJI : [],
    pitch: isYomu ? [pitch('よむ', 1, '頭高型')] : [],
    frequency: isYomu ? [{ dictTitle: 'JPDB', value: 320, displayValue: '320' }] : [],
  };
}
