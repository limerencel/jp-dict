/**
 * 助词语境判定：为每个助词单位选出最可能的义项，并指出它前后各是什么成分。
 *
 * 判定策略是「务实优先」：先用可靠的形态线索（谓语的活用要素、kuromoji 的细分词性），
 * 再用有限的语义词表（移动动词、场所名词、时间名词……）。
 * 每条结论都带 reason，说明依据，判不准时退回该助词的首选义项。
 */
import type { ParticleArgument, ParticleCategory, ParticleInfo, ParticleSense, Word } from '../../shared/types.ts';
import { toRomaji } from '../../shared/kana.ts';
import {
  CATEGORY_LABEL,
  COMPOUND_MAP,
  JA_CATEGORY_MAP,
  fallbackDef,
  getParticleDef,
} from './particleData.ts';

/* ────────────────────────────── 语义词表 ────────────────────────────── */

const set = (...xs: string[]): Set<string> => new Set(xs);

/** 移动动词：与「に／へ」构成归着点 */
const MOVEMENT_VERBS = set(
  '行く', 'いく', 'ゆく', '来る', 'くる', '帰る', '戻る', '入る', '出る', '着く', '到着する',
  '向かう', '通う', '登る', '上がる', '下りる', '乗る', '移る', '引っ越す', '届く', '寄る', '通る', '進む',
);

/** 存在·居住动词：与「に」构成存在场所 */
const EXISTENCE_VERBS = set('ある', 'いる', 'おる', '住む', '座る', '立つ', '泊まる', '勤める', '残る', '置く', '並ぶ', '書く');

/** 经过点动词：与「を」构成通过的场所 */
const PATH_VERBS = set('歩く', '走る', '通る', '渡る', '散歩する', '飛ぶ', '泳ぐ', '曲がる', '登る', '越える', '横切る');

/** 离脱动词：与「を」构成起点 */
const LEAVE_VERBS = set('出る', '降りる', '卒業する', '離れる', '去る', '発つ', '出発する', '退く');

/** 引用动词：与「と／って」构成引用 */
const QUOTE_VERBS = set(
  '言う', 'いう', '思う', '考える', '聞く', '答える', '話す', '書く', '呼ぶ', '叫ぶ', '感じる',
  '決める', '伝える', '教える', '発表する', '主張する', '報告する', '返事する',
);

/** 授受·传达动词：与「に」构成接受者 */
const RECIPIENT_VERBS = set(
  'あげる', 'やる', 'くれる', 'くださる', 'さしあげる', '貸す', '送る', '教える', '見せる', '渡す',
  '売る', '話す', '書く', '電話する', '会う', '相談する', '聞く', '言う', '伝える', '払う', '返す', '紹介する',
);

/** 来源动词：与「に／から」构成来源 */
const SOURCE_VERBS = set('習う', 'もらう', 'いただく', '借りる', '教わる', '受ける', '聞く', '学ぶ');

/** 变化动词：与「に／と」构成变化结果 */
const BECOME_VERBS = set('なる', 'する', '変わる', '変える', '決まる', '決める');

/** 感情·能力谓语：前面的「が」是对象语 */
// 注：「ある・いる」故意不收——「四季がある」里的「が」按主语理解对学习者更自然，
// 它们已在 PHENOMENON_VERBS 里处理。
const OBJECT_PREDICATES = set(
  '好き', '嫌い', '上手', '下手', '得意', '苦手', '欲しい', 'ほしい', '必要', '大切', '心配', '嫌',
  'わかる', '分かる', 'できる', '見える', '聞こえる', '要る', '上手い', 'うまい',
);

/** 自然现象·出现类动词：前面的「が」多为现象描写 */
const PHENOMENON_VERBS = set('降る', '吹く', '咲く', '鳴る', '光る', '起きる', '起こる', '始まる', '終わる', '来る', 'ある', 'いる', '見える', '聞こえる');

/** 比较·基准谓语 */
const CRITERION_PREDICATES = set('近い', '遠い', '似る', '慣れる', '比べる', '対する', '当たる', '反対する', '賛成する', '強い', '弱い', '詳しい');

/** 共同动作动词：与「と」构成共同者 */
const COMPANION_VERBS = set('話す', '会う', '結婚する', '遊ぶ', '相談する', 'けんかする', '喧嘩する', '付き合う', '出会う', '別れる', '一緒', '暮らす');

/** 比较谓语：与「と」构成比较对象 */
const COMPARISON_PREDICATES = set('同じ', '違う', '異なる', '比べる', '似る', '等しい');

/** 制作动词：与「で／から」构成材料 */
const MAKE_VERBS = set('作る', 'つくる', 'できる', '造る', '建てる', '焼く');

const TIME_NOUNS = set(
  '今日', '明日', '昨日', '今朝', '今晩', '今夜', '毎朝', '毎日', '毎晩', '毎年', '毎週', '毎月',
  '朝', '昼', '夜', '晩', '夕方', '午前', '午後', '春', '夏', '秋', '冬', '今', '昔', '将来', '最近',
  '来年', '去年', '今年', '来週', '先週', '今週', '今月', '来月', '先月', '週末', '正月', '誕生日',
  '時', '時間', '瞬間', '当時', '以前', '以後', '後', '前', '間', '頃', 'ころ', '休み', '夏休み',
);

/** 时间量词 */
const TIME_COUNTERS = set('時', '分', '秒', '日', '月', '年', '週', '週間', '時間', '日間', 'ヶ月', 'か月', 'カ月', '年間', '歳', '才', '日目');

const PLACE_NOUNS = set(
  '学校', '公園', '家', 'うち', '駅', '会社', '教室', '図書館', '店', '部屋', '町', '国', '日本', '中国',
  '東京', '大阪', '京都', 'レストラン', '病院', '大学', '銀行', '空港', '海', '山', '川', '道', '街',
  '職場', '事務所', '工場', '教会', '神社', '寺', 'ホテル', '喫茶店', 'スーパー', 'コンビニ', '台所',
  '庭', '外', '中', '上', '下', '前', '後ろ', '隣', '近く', 'そば', 'ここ', 'そこ', 'あそこ', 'どこ',
);

/** 场所性后缀，用于兜底判断 */
const PLACE_SUFFIXES = ['校', '館', '店', '室', '場', '屋', '園', '駅', '院', '社', '国', '市', '町', '村', '山', '川', '海', '道', '県', '府', '区'];

const TOOL_NOUNS = set(
  'バス', '電車', '車', '自転車', 'バイク', '飛行機', '船', 'タクシー', '新幹線', '地下鉄', '徒歩',
  '箸', 'ペン', '鉛筆', 'ナイフ', 'はさみ', '手', '足', '目', '頭', 'パソコン', 'スマホ', '電話',
  'メール', 'インターネット', '日本語', '英語', '中国語', '声', '現金', 'カード', '写真', '機械',
);

const CAUSE_NOUNS = set('病気', '風邪', '事故', '地震', '台風', '火事', '仕事', '用事', '都合', '理由', '雨', '雪', '疲れ', '寝坊', '渋滞', 'ストレス');

const PERSON_NOUNS = set(
  '人', '先生', '学生', '友達', '母', '父', '子供', '彼', '彼女', '私', 'わたし', '僕', '俺', '君',
  'あなた', 'みんな', '皆', '兄', '姉', '弟', '妹', '家族', '親', '両親', '息子', '娘', '妻', '夫',
  '社長', '部長', '医者', '警察', '客', '相手', '誰', 'だれ', '自分', '祖母', '祖父', '先輩', '後輩', '同僚',
);

const PERSON_SUFFIXES = ['人', '者', '員', '師', '生', '家', '士', '長', '君', 'さん', '様', 'ちゃん', '達', 'たち', 'ら'];

const INTERROGATIVES = set('何', 'なに', 'なん', '誰', 'だれ', 'どこ', 'いつ', 'どれ', 'どちら', 'どう', 'なぜ', 'どんな', 'いくら', 'いくつ', 'どの');

/* ────────────────────────────── 词判定小工具 ────────────────────────────── */

function isContent(w: Word): boolean {
  return w.pos !== 'symbol' && w.pos !== 'whitespace';
}

function isPredicateWord(w: Word): boolean {
  if (w.pos === 'verb' || w.pos === 'i-adjective' || w.pos === 'na-adjective' || w.pos === 'auxiliary') return true;
  // 名词 + 断定助动词（学生だ / つもりだ）
  const tail = w.subTokens[w.subTokens.length - 1];
  return Boolean(tail && tail.posJa === '助動詞');
}

function endsWithAny(s: string, list: string[]): boolean {
  return list.some((suf) => s.length > suf.length && s.endsWith(suf));
}

function isTimeWord(w: Word): boolean {
  if (TIME_NOUNS.has(w.lemma) || TIME_NOUNS.has(w.surface)) return true;
  if (w.pos === 'counter') {
    const tail = w.subTokens[w.subTokens.length - 1];
    if (tail && TIME_COUNTERS.has(tail.surface)) return true;
  }
  return /^[0-9０-９一二三四五六七八九十百千]+(年|月|日|時|分|秒|時間|週間|ヶ月)$/.test(w.surface);
}

function isPlaceWord(w: Word): boolean {
  if (PLACE_NOUNS.has(w.lemma) || PLACE_NOUNS.has(w.surface)) return true;
  if (w.posLabel.includes('地名')) return true;
  return endsWithAny(w.lemma, PLACE_SUFFIXES);
}

function isPersonWord(w: Word): boolean {
  if (w.pos === 'pronoun') return true;
  if (PERSON_NOUNS.has(w.lemma) || PERSON_NOUNS.has(w.surface)) return true;
  if (w.posLabel.includes('人名')) return true;
  return endsWithAny(w.lemma, PERSON_SUFFIXES);
}

function isQuantity(w: Word): boolean {
  return w.pos === 'number' || w.pos === 'counter';
}

function hasFeature(w: Word | undefined, ...features: string[]): boolean {
  if (!w?.inflection) return false;
  return features.some((f) => w.inflection!.features.some((x) => x.includes(f)));
}

function isNegative(w: Word | undefined): boolean {
  return hasFeature(w, '否定');
}

/** 谓语的核心词（去掉附属成分后的辞書形） */
function predLemma(w: Word | undefined): string {
  return w?.lemma ?? '';
}

/* ────────────────────────────── 上下文 ────────────────────────────── */

interface Ctx {
  words: Word[];
  index: number;
  self: Word;
  /** kuromoji 给出的助词细分（格助詞 / 係助詞 …） */
  detailJa: string;
  prev?: Word;
  next?: Word;
  /** 向后最近的谓语单位 */
  predicate?: Word;
  /** 同句词 */
  sentence: Word[];
}

function buildCtx(words: Word[], index: number): Ctx {
  const self = words[index];
  const sentence = words.filter((w) => w.sentenceIndex === self.sentenceIndex);
  const pos = sentence.indexOf(self);

  let prev: Word | undefined;
  for (let i = pos - 1; i >= 0; i--) {
    if (isContent(sentence[i])) {
      prev = sentence[i];
      break;
    }
  }
  // 复合助词（には / のは …）时，把「前接成分」继续往前找到实词
  if (prev?.isParticle && COMPOUND_MAP.has(`${prev.surface}\u0000${self.surface}`)) {
    const prevPos = sentence.indexOf(prev);
    for (let i = prevPos - 1; i >= 0; i--) {
      if (isContent(sentence[i]) && !sentence[i].isParticle) {
        prev = sentence[i];
        break;
      }
    }
  }

  let next: Word | undefined;
  for (let i = pos + 1; i < sentence.length; i++) {
    if (isContent(sentence[i])) {
      next = sentence[i];
      break;
    }
  }

  let predicate: Word | undefined;
  for (let i = pos + 1; i < sentence.length; i++) {
    const w = sentence[i];
    if (!isContent(w) || w.isParticle) continue;
    if (isPredicateWord(w)) {
      predicate = w;
      break;
    }
  }

  return {
    words,
    index,
    self,
    detailJa: self.subTokens[0]?.posDetail[0] ?? '',
    prev,
    next,
    predicate,
    sentence,
  };
}

/* ────────────────────────────── 判定结果 ────────────────────────────── */

interface Resolution {
  key: string;
  reason: string;
  beforeRole?: string;
  afterRole?: string;
  /** 覆盖默认的 after 目标（默认取向后最近的谓语） */
  afterTarget?: Word;
  /** 完全自定义的结构说明 */
  structure?: string;
}

const FINAL_ROLE = { beforeRole: '陈述内容', afterRole: '' };

/* ────────────────────────────── 各助词的判定 ────────────────────────────── */

/** 判断某个助词是否紧跟在另一个助词后面（即复合助词的后半） */
function followsParticle(sentence: Word[], w: Word): boolean {
  const idx = sentence.indexOf(w);
  for (let i = idx - 1; i >= 0; i--) {
    if (!isContent(sentence[i])) continue;
    return sentence[i].isParticle;
  }
  return false;
}

function resolveWa(c: Ctx): Resolution {
  // 「には」「では」这类复合形式里的は，不参与「句中多个は→对比」的计数
  const count = c.sentence.filter(
    (w) => w.isParticle && w.surface === 'は' && !followsParticle(c.sentence, w),
  ).length;
  const pred = c.predicate;
  if (count >= 2) {
    return {
      key: 'contrast',
      reason: `本句中出现了 ${count} 个「は」，彼此形成对照，因此判定为对比用法。`,
      beforeRole: '对比的一方',
      afterRole: '对该项的陈述',
    };
  }
  // 否定的焦点只能有一个：若自己与否定谓语之间还夹着另一个は，则本位置仍是主题
  const laterWa =
    pred !== undefined &&
    c.sentence.some(
      (w) => w.isParticle && w.surface === 'は' && w.start > c.self.start && w.start < pred.start,
    );
  if (isNegative(pred) && !laterWa) {
    return {
      key: 'negative-scope',
      reason: `后面的谓语「${pred?.surface}」是否定形，「は」把否定限定在「${c.prev?.surface ?? ''}」这一项上（暗示别的未必如此）。`,
      beforeRole: '否定所针对的项',
      afterRole: '否定谓语',
    };
  }
  return {
    key: 'topic',
    reason: `「${c.prev?.surface ?? ''}」被提为全句话题，后面的「${pred?.surface ?? ''}」是对它的陈述。`,
    beforeRole: '主题',
    afterRole: '对主题的陈述',
  };
}

function resolveGa(c: Ctx): Resolution {
  if (c.detailJa === '接続助詞') {
    const before = c.prev;
    if (before && /^(すみません|失礼|恐れ入り)/.test(before.surface)) {
      return { key: 'preface', reason: '前接客套语，属于引出正题的前置铺垫，并无转折含义。', beforeRole: '铺垫句', afterRole: '正题' };
    }
    return {
      key: 'conjunction-contrast',
      reason: '接在活用词终止形之后，连接前后两个小句，表示逆接。',
      beforeRole: '前句（让步）',
      afterRole: '后句（转折）',
    };
  }
  const pred = c.predicate;
  const lemma = predLemma(pred);
  if (pred && (OBJECT_PREDICATES.has(lemma) || OBJECT_PREDICATES.has(pred.surface))) {
    return {
      key: 'object',
      reason: `谓语「${pred.surface}」属于感情／能力／存在类，它前面的「が」标示的是对象而非施事。`,
      beforeRole: '对象语',
      afterRole: '感情／能力谓语',
    };
  }
  const hasTopic = c.sentence.some((w) => w.isParticle && w.surface === 'は' && w.start < c.self.start);
  if (pred && PHENOMENON_VERBS.has(lemma) && !hasTopic) {
    return {
      key: 'phenomenon',
      reason: `谓语「${pred.surface}」描述自然现象或事态出现，整句是对眼前情况的客观描写。`,
      beforeRole: '现象的主体',
      afterRole: '现象谓语',
    };
  }
  return {
    key: 'subject',
    reason: pred
      ? `「${c.prev?.surface ?? ''}」是「${pred.surface}」的动作／状态主体。`
      : '标示动作或状态的主体。',
    beforeRole: '动作主体',
    afterRole: '谓语',
  };
}

function resolveO(c: Ctx): Resolution {
  const pred = c.predicate;
  const lemma = predLemma(pred);
  if (pred && PATH_VERBS.has(lemma)) {
    return {
      key: 'path',
      reason: `谓语「${pred.surface}」是移动动词，「を」在这里表示经过、穿行的场所，而不是宾语。`,
      beforeRole: '经过的场所',
      afterRole: '移动动词',
    };
  }
  if (pred && LEAVE_VERBS.has(lemma)) {
    return {
      key: 'departure',
      reason: `谓语「${pred.surface}」表示脱离，「を」标示离开的起点。`,
      beforeRole: '离开的场所',
      afterRole: '离脱动词',
    };
  }
  if (pred && hasFeature(pred, '使役') && c.prev && isPersonWord(c.prev)) {
    return {
      key: 'causative-agent',
      reason: `谓语「${pred.surface}」是使役形，前面的「${c.prev.surface}」是被驱使去做动作的一方。`,
      beforeRole: '被使役者',
      afterRole: '使役谓语',
    };
  }
  if (c.prev && isTimeWord(c.prev) && /過ごす|送る/.test(lemma)) {
    return { key: 'duration', reason: '前接时间名词、后接「過ごす／送る」，表示度过的时间。', beforeRole: '经历的时间', afterRole: '谓语' };
  }
  return {
    key: 'direct-object',
    reason: pred ? `「${c.prev?.surface ?? ''}」是他动词「${pred.surface}」直接作用的对象。` : '标示他动词的直接宾语。',
    beforeRole: '动作对象',
    afterRole: '他动词谓语',
  };
}

function resolveNi(c: Ctx): Resolution {
  const pred = c.predicate;
  const lemma = predLemma(pred);
  const prev = c.prev;

  if (pred && hasFeature(pred, '被动', '使役') && prev && isPersonWord(prev)) {
    const kind = hasFeature(pred, '使役') && hasFeature(pred, '被动') ? '使役被动' : hasFeature(pred, '使役') ? '使役' : '被动';
    return {
      key: 'agent',
      reason: `谓语「${pred.surface}」是${kind}形，「${prev.surface}」是实际发出动作／下达指令的一方。`,
      beforeRole: '动作主体（施事）',
      afterRole: `${kind}谓语`,
    };
  }
  if (prev && isTimeWord(prev)) {
    const nextQ = c.next;
    if (nextQ && isQuantity(nextQ) && /^(週|月|年|日|時間)/.test(prev.surface)) {
      return { key: 'frequency', reason: `「${prev.surface}に${nextQ.surface}」是「单位时间内几次」的频率表达。`, beforeRole: '时间单位', afterRole: '次数' };
    }
    return {
      key: 'time',
      reason: `「${prev.surface}」是具体时间，「に」指出动作发生的时刻。`,
      beforeRole: '时间点',
      afterRole: '谓语',
    };
  }
  if (pred && BECOME_VERBS.has(lemma)) {
    return { key: 'result', reason: `谓语「${pred.surface}」表示变化，「に」标示变成的结果。`, beforeRole: '变化结果', afterRole: '变化动词' };
  }
  if (prev && (prev.pos === 'verb' || prev.posLabel.includes('サ变')) && pred && MOVEMENT_VERBS.has(lemma)) {
    return { key: 'purpose', reason: `「${prev.surface}に${pred.surface}」是「去做某事」的目的表达。`, beforeRole: '目的（动作）', afterRole: '移动动词' };
  }
  if (pred && MOVEMENT_VERBS.has(lemma)) {
    return { key: 'goal', reason: `谓语「${pred.surface}」是移动动词，「に」标示到达点。`, beforeRole: '归着点', afterRole: '移动动词' };
  }
  if (pred && EXISTENCE_VERBS.has(lemma)) {
    return { key: 'location', reason: `谓语「${pred.surface}」是存在／状态动词，「に」标示存在的场所。`, beforeRole: '存在场所', afterRole: '存在动词' };
  }
  if (pred && SOURCE_VERBS.has(lemma)) {
    return { key: 'source', reason: `谓语「${pred.surface}」表示获得，「に」标示来源方。`, beforeRole: '来源', afterRole: '获得动词' };
  }
  if (pred && RECIPIENT_VERBS.has(lemma)) {
    return { key: 'recipient', reason: `谓语「${pred.surface}」需要一个接受方，「${prev?.surface ?? ''}」就是动作指向的对象。`, beforeRole: '接受者', afterRole: '谓语' };
  }
  if (pred && CRITERION_PREDICATES.has(lemma)) {
    return { key: 'criterion', reason: `谓语「${pred.surface}」需要一个参照对象。`, beforeRole: '比较基准', afterRole: '谓语' };
  }
  if (prev && isPlaceWord(prev)) {
    return { key: 'location', reason: `「${prev.surface}」是场所名词，缺少更强线索时按存在／归着场所理解。`, beforeRole: '场所', afterRole: '谓语' };
  }
  if (prev && isPersonWord(prev)) {
    return { key: 'recipient', reason: `「${prev.surface}」指人，「に」最可能标示动作指向的对象。`, beforeRole: '对象', afterRole: '谓语' };
  }
  return { key: 'goal', reason: '缺少更强线索，按最常见的归着点／对象理解。', beforeRole: '归着点／对象', afterRole: '谓语' };
}

function resolveE(c: Ctx): Resolution {
  if (c.next?.surface === 'の') {
    return { key: 'recipient', reason: '后接「の」构成「〜への」，修饰名词，表示送达的对象。', beforeRole: '送达对象', afterRole: '被修饰名词' };
  }
  const pred = c.predicate;
  if (pred && MOVEMENT_VERBS.has(predLemma(pred))) {
    return {
      key: 'destination',
      reason: `谓语「${pred.surface}」是移动动词，「へ」标示前往的目的地（比「に」更侧重方向）。`,
      beforeRole: '目的地',
      afterRole: '移动动词',
    };
  }
  return { key: 'direction', reason: '「へ」标示移动的方向。', beforeRole: '方向', afterRole: '谓语' };
}

function resolveDe(c: Ctx): Resolution {
  if (c.detailJa === '接続助詞') {
    return { key: 'conjunctive', reason: '这是て形的浊化形式，用于连接前后动作。', beforeRole: '前项动作', afterRole: '后项动作' };
  }
  const prev = c.prev;
  const pred = c.predicate;
  const lemma = predLemma(pred);
  // 「〇ではない／ではありません」：这里的「で」实际是断定助动词「だ」的连用形
  if (c.next?.surface === 'は' && (lemma === 'ある' || lemma === 'ない' || lemma === 'ござる')) {
    return {
      key: 'copula-negation',
      reason: `后面是「は＋${pred?.surface ?? 'ない'}」，三者合起来是断定助动词「だ」的否定形「ではない」，而不是格助词。`,
      beforeRole: '被否定的判断内容',
      afterRole: '否定的系动词',
    };
  }
  if (prev && CAUSE_NOUNS.has(prev.lemma)) {
    return { key: 'cause', reason: `「${prev.surface}」是表示事态的名词，「で」说明后项的起因。`, beforeRole: '原因', afterRole: '结果／谓语' };
  }
  if (prev && MAKE_VERBS.has(lemma) && !isPlaceWord(prev) && !TOOL_NOUNS.has(prev.lemma)) {
    return { key: 'material', reason: `谓语「${pred?.surface}」是制作类动词，「${prev.surface}」是可见的原材料。`, beforeRole: '材料', afterRole: '制作动词' };
  }
  if (prev && isQuantity(prev)) {
    if (isTimeWord(prev)) {
      return { key: 'time-limit', reason: `「${prev.surface}で」表示在这段时间内完成。`, beforeRole: '所需时间', afterRole: '谓语' };
    }
    return { key: 'scope', reason: `「${prev.surface}で」限定人数／金额等范围或总计。`, beforeRole: '范围／总计', afterRole: '谓语' };
  }
  if (prev && isPlaceWord(prev)) {
    return {
      key: 'place',
      reason: `「${prev.surface}」是场所名词，且后项「${pred?.surface ?? ''}」是动作动词，因此「で」标示动作发生的地点。`,
      beforeRole: '动作场所',
      afterRole: '动作谓语',
    };
  }
  if (prev && TOOL_NOUNS.has(prev.lemma)) {
    return { key: 'means', reason: `「${prev.surface}」是交通工具／器具／语言一类，「で」标示手段。`, beforeRole: '手段／工具', afterRole: '谓语' };
  }
  return { key: 'means', reason: '缺少更强线索，按最常见的手段／方式理解。', beforeRole: '手段／方式', afterRole: '谓语' };
}

function resolveTo(c: Ctx): Resolution {
  const pred = c.predicate;
  const lemma = predLemma(pred);
  const prev = c.prev;
  const next = c.next;

  if (c.detailJa === '引用' || (pred && QUOTE_VERBS.has(lemma))) {
    return {
      key: 'quote',
      reason: `后面的「${pred?.surface ?? ''}」是引用动词，「と」把前面的内容作为说话或思考的内容引出来。`,
      beforeRole: '引用内容',
      afterRole: '引用动词',
    };
  }
  if (pred && COMPARISON_PREDICATES.has(lemma)) {
    return { key: 'comparison', reason: `谓语「${pred.surface}」表示异同比较，「と」标示比较的另一方。`, beforeRole: '比较对象', afterRole: '比较谓语' };
  }
  if (pred && BECOME_VERBS.has(lemma)) {
    return { key: 'change', reason: `「〜となる」是书面语的变化表达。`, beforeRole: '变化结果', afterRole: '变化动词' };
  }
  if (pred && COMPANION_VERBS.has(lemma)) {
    return { key: 'companion', reason: `谓语「${pred.surface}」是需要对方参与的动作，「${prev?.surface ?? ''}」是共同者。`, beforeRole: '共同者', afterRole: '共同动作' };
  }
  if (prev && prev.pos === 'verb' && !prev.inflection?.features.length) {
    return { key: 'conditional', reason: `前接动词终止形「${prev.surface}」，表示「一……就……」的必然结果。`, beforeRole: '条件', afterRole: '必然结果' };
  }
  if (next && ['noun', 'pronoun', 'propernoun', 'number', 'counter'].includes(next.pos) && prev && ['noun', 'pronoun', 'propernoun', 'number', 'counter'].includes(prev.pos)) {
    return {
      key: 'parallel',
      reason: `「と」前后都是体言（${prev.surface} / ${next.surface}），构成穷尽列举。`,
      beforeRole: '并列项',
      afterRole: '并列项',
      afterTarget: next,
    };
  }
  if (prev && isPersonWord(prev)) {
    return { key: 'companion', reason: `「${prev.surface}」指人，最可能是一起做动作的对方。`, beforeRole: '共同者', afterRole: '谓语' };
  }
  return { key: 'parallel', reason: '缺少更强线索，按并列理解。', beforeRole: '并列项', afterRole: '并列项', afterTarget: next };
}

function resolveNo(c: Ctx): Resolution {
  const prev = c.prev;
  const next = c.next;

  // 准体助词（kuromoji 标为名詞非自立）
  if (c.self.posJa === '名詞') {
    if (prev && (prev.pos === 'verb' || prev.pos === 'auxiliary')) {
      return {
        key: 'nominalizer',
        reason: `前接动词单位「${prev.surface}」，「の」把这个小句整体名词化，使它能充当主语或宾语。`,
        beforeRole: '被名词化的小句',
        afterRole: '对名词化内容的陈述',
      };
    }
    if (prev && (prev.pos === 'i-adjective' || prev.pos === 'na-adjective' || prev.pos === 'prenominal')) {
      return {
        key: 'substitute',
        reason: `前接修饰成分「${prev.surface}」，「の」代替上下文中已知的名词。`,
        beforeRole: '修饰语',
        afterRole: '谓语',
      };
    }
    return { key: 'nominalizer', reason: '「の」在此充当形式名词，把前面的内容体言化。', beforeRole: '被名词化的内容', afterRole: '谓语' };
  }

  if (c.detailJa === '終助詞') {
    return { key: 'final', reason: '位于句末，表示疑问或柔和的说明语气。', ...FINAL_ROLE };
  }
  if (next && (next.pos === 'verb' || next.pos === 'i-adjective') ) {
    return {
      key: 'subject-in-clause',
      reason: `「の」后面紧跟活用词「${next.surface}」，说明这是连体修饰节内部代替「が」的小主语。`,
      beforeRole: '从句主语',
      afterRole: '从句谓语',
      afterTarget: next,
    };
  }
  if (prev && next && isPersonWord(next) && (isPersonWord(prev) || prev.pos === 'noun')) {
    return {
      key: 'apposition',
      reason: `「${prev.surface}」与「${next.surface}」指同一个人／事物，构成同位语。`,
      beforeRole: '限定语',
      afterRole: '被修饰名词',
      afterTarget: next,
    };
  }
  return {
    key: 'possession',
    reason: `「${prev?.surface ?? ''}」限定后面的「${next?.surface ?? ''}」，表示所属、属性等关系。`,
    beforeRole: '所有者／限定语',
    afterRole: '被修饰名词',
    afterTarget: next,
  };
}

function resolveKara(c: Ctx): Resolution {
  const prev = c.prev;
  const pred = c.predicate;
  const lemma = predLemma(pred);
  if (c.detailJa === '接続助詞' || (prev && isPredicateWord(prev) && !isTimeWord(prev) && !isPlaceWord(prev))) {
    if (prev && hasFeature(prev, 'て形')) {
      return { key: 'after', reason: `前接て形「${prev.surface}」，「〜てから」表示做完前项之后。`, beforeRole: '先行动作', afterRole: '后续动作' };
    }
    return { key: 'reason', reason: `前接活用词终止形「${prev?.surface ?? ''}」，「から」说明主观理由。`, beforeRole: '原因', afterRole: '结果' };
  }
  if (pred && MAKE_VERBS.has(lemma)) {
    return { key: 'material', reason: `谓语「${pred.surface}」是制作类动词，「から」表示看不出原形的原料。`, beforeRole: '原料', afterRole: '制作动词' };
  }
  if (prev && isPersonWord(prev)) {
    return { key: 'source-person', reason: `「${prev.surface}」指人／机构，「から」标示来源方。`, beforeRole: '来源方', afterRole: '谓语' };
  }
  return { key: 'start-point', reason: `「${prev?.surface ?? ''}」是时间或空间的出发点。`, beforeRole: '起点', afterRole: '谓语' };
}

function resolveMo(c: Ctx): Resolution {
  const prev = c.prev;
  const count = c.sentence.filter((w) => w.isParticle && w.surface === 'も').length;
  // て形＋も → 「〇ても」的逆接让步（kuromoji 会把て归入前面的动词单位）
  if (prev && hasFeature(prev, 'て形')) {
    return {
      key: 'concession',
      reason: `前接て形「${prev.surface}」，两者合成「〇ても」，表示即使前项成立后项依然不变。`,
      beforeRole: '让步条件',
      afterRole: '结论',
    };
  }
  if (prev && INTERROGATIVES.has(prev.lemma) && isNegative(c.predicate)) {
    return { key: 'total-negation', reason: '「疑问词＋も＋否定」表示全面否定。', beforeRole: '被否定的范围', afterRole: '否定谓语' };
  }
  if (prev && isQuantity(prev)) {
    return { key: 'emphasis-quantity', reason: `接在数量词「${prev.surface}」后，强调数量之多／出乎意料。`, beforeRole: '数量', afterRole: '谓语' };
  }
  if (count >= 2) {
    return { key: 'parallel', reason: `本句出现 ${count} 个「も」，构成「AもBも」的并举。`, beforeRole: '并列项', afterRole: '谓语' };
  }
  return { key: 'also', reason: `「${prev?.surface ?? ''}」被归入与前文相同的范畴，相当于「也」。`, beforeRole: '类同项', afterRole: '谓语' };
}

function resolveKa(c: Ctx): Resolution {
  const isSentenceEnd = !c.next || c.next.pos === 'symbol';
  if (isSentenceEnd) return { key: 'question', reason: '位于句末，构成疑问句。', ...FINAL_ROLE };
  if (c.prev && INTERROGATIVES.has(c.prev.lemma)) {
    return { key: 'uncertain', reason: `前接疑问词「${c.prev.surface}」，表示不特定的某个。`, beforeRole: '疑问词', afterRole: '谓语' };
  }
  if (c.next && ['noun', 'pronoun', 'propernoun', 'number'].includes(c.next.pos)) {
    return { key: 'alternative', reason: '前后都是体言，表示二者择一。', beforeRole: '选项', afterRole: '选项', afterTarget: c.next };
  }
  return { key: 'embedded', reason: '引导间接疑问从句。', beforeRole: '疑问内容', afterRole: '主句谓语' };
}

function resolveNa(c: Ctx): Resolution {
  const prev = c.prev;
  if (prev && prev.pos === 'verb' && !prev.inflection?.features.length) {
    return { key: 'prohibition', reason: `前接动词终止形「${prev.surface}」，构成禁止形「〜な」。`, beforeRole: '被禁止的动作', afterRole: '' };
  }
  if (prev && prev.pos === 'verb' && hasFeature(prev, '连用形')) {
    return { key: 'command', reason: `前接动词连用形「${prev.surface}」，是「〜なさい」的口语省略。`, beforeRole: '要求的动作', afterRole: '' };
  }
  return { key: 'exclamation', reason: '位于句末抒发感慨或自我确认。', ...FINAL_ROLE };
}

function resolveBakari(c: Ctx): Resolution {
  if (c.prev && isQuantity(c.prev)) return { key: 'approx', reason: `接在数量词「${c.prev.surface}」后表示概数。`, beforeRole: '数量', afterRole: '谓语' };
  if (hasFeature(c.prev, '过去')) return { key: 'just-done', reason: `前接过去形「${c.prev?.surface}」，「〜たばかり」表示刚做完。`, beforeRole: '刚完成的动作', afterRole: '谓语' };
  return { key: 'only', reason: '限定范围，含说话人「净是如此」的评价。', beforeRole: '被限定项', afterRole: '谓语' };
}

function resolveHodo(c: Ctx): Resolution {
  if (isNegative(c.predicate)) return { key: 'negative-comparison', reason: `后接否定谓语「${c.predicate?.surface}」，构成「〜ほど〜ない」的比较否定。`, beforeRole: '比较基准', afterRole: '否定谓语' };
  if (c.prev && isQuantity(c.prev)) return { key: 'approx', reason: `接在数量词「${c.prev.surface}」后表示概数。`, beforeRole: '数量', afterRole: '谓语' };
  return { key: 'extent', reason: '通过前项说明后项的程度。', beforeRole: '程度的比喻', afterRole: '谓语' };
}

function resolveKurai(c: Ctx): Resolution {
  if (c.prev && isQuantity(c.prev)) return { key: 'approx', reason: `接在数量词「${c.prev.surface}」后表示概数。`, beforeRole: '数量', afterRole: '谓语' };
  return { key: 'extent', reason: '举例说明程度。', beforeRole: '程度的比喻', afterRole: '谓语' };
}

function resolveDemo(c: Ctx): Resolution {
  if (c.detailJa === '接続助詞') return { key: 'concession', reason: '连接前后小句，表示即使前项成立后项也不变。', beforeRole: '让步条件', afterRole: '结论' };
  if (c.prev && INTERROGATIVES.has(c.prev.lemma)) return { key: 'any', reason: `前接疑问词「${c.prev.surface}」，表示无论哪个都可以。`, beforeRole: '疑问词', afterRole: '谓语' };
  return { key: 'suggestion', reason: '随便举一个例子，语气委婉。', beforeRole: '例示项', afterRole: '谓语' };
}

function resolveTte(c: Ctx): Resolution {
  const pred = c.predicate;
  if (pred && QUOTE_VERBS.has(predLemma(pred))) {
    return { key: 'quote', reason: `后接引用动词「${pred.surface}」，「って」是口语的「と」。`, beforeRole: '引用内容', afterRole: '引用动词' };
  }
  if (!c.next || c.next.pos === 'symbol') return { key: 'hearsay', reason: '位于句末，表示听说来的信息。', ...FINAL_ROLE };
  return { key: 'topic', reason: '口语中代替「は」提示话题或下定义。', beforeRole: '主题', afterRole: '对主题的陈述' };
}

function resolveNoni(c: Ctx): Resolution {
  const pred = c.predicate;
  if (pred && /使う|便利|役立つ|要る|かかる|必要/.test(pred.lemma + pred.surface)) {
    return { key: 'purpose', reason: `后项「${pred.surface}」表示用途／所需，「のに」是「为了做……」。`, beforeRole: '用途（动作）', afterRole: '评价' };
  }
  return { key: 'contrary', reason: '连接语义相悖的前后项，带有意外或不满的情绪。', beforeRole: '前提', afterRole: '意外的结果' };
}

function resolveSae(c: Ctx): Resolution {
  const after = c.sentence.slice(c.sentence.indexOf(c.self) + 1);
  if (after.some((w) => w.surface === 'ば' || hasFeature(w, '假定形'))) {
    return { key: 'minimum-condition', reason: '与后面的「ば」呼应，构成「〜さえ〜ば」的唯一条件。', beforeRole: '唯一条件', afterRole: '结果' };
  }
  return { key: 'even', reason: '举出极端例子类推其余。', beforeRole: '极端例子', afterRole: '谓语' };
}

function resolveMade(c: Ctx): Resolution {
  if (c.next?.surface === 'に') return { key: 'limit', reason: '后接「に」构成「〜までに」，表示期限。', beforeRole: '期限', afterRole: '谓语' };
  if (c.prev && (isTimeWord(c.prev) || isPlaceWord(c.prev))) {
    return { key: 'end-point', reason: `「${c.prev.surface}」是时间或场所，「まで」标示终点。`, beforeRole: '终点', afterRole: '谓语' };
  }
  return { key: 'extent', reason: '举出令人意外的例子，相当于「甚至连……」。', beforeRole: '极端例子', afterRole: '谓语' };
}

function resolveYori(c: Ctx): Resolution {
  const pred = c.predicate;
  if (pred && (pred.pos === 'i-adjective' || pred.pos === 'na-adjective')) {
    return { key: 'comparison', reason: `后项谓语「${pred.surface}」是形容词，「より」标示比较的基准。`, beforeRole: '比较基准', afterRole: '比较结果' };
  }
  if (c.prev && isTimeWord(c.prev)) return { key: 'start-point', reason: '书面语中代替「から」表示起点。', beforeRole: '起点', afterRole: '谓语' };
  return { key: 'comparison', reason: '标示比较的对象。', beforeRole: '比较基准', afterRole: '比较结果' };
}

/** 接续助词的通用处理：前项小句 → 后项小句 */
function resolveConjunctive(c: Ctx, key: string, reason: string, beforeRole: string, afterRole: string): Resolution {
  return { key, reason, beforeRole, afterRole };
}

/* ────────────────────────────── 分派 ────────────────────────────── */

function resolve(c: Ctx): Resolution {
  const p = c.self.surface;
  switch (p) {
    case 'は': return resolveWa(c);
    case 'が': return resolveGa(c);
    case 'を': return resolveO(c);
    case 'に': return resolveNi(c);
    case 'へ': return resolveE(c);
    case 'で': return resolveDe(c);
    case 'と': return resolveTo(c);
    case 'の': return resolveNo(c);
    case 'から': return resolveKara(c);
    case 'も': return resolveMo(c);
    case 'か': return resolveKa(c);
    case 'な': return resolveNa(c);
    case 'ばかり': return resolveBakari(c);
    case 'ほど': return resolveHodo(c);
    case 'くらい':
    case 'ぐらい': return resolveKurai(c);
    case 'でも': return resolveDemo(c);
    case 'って': return resolveTte(c);
    case 'のに': return resolveNoni(c);
    case 'さえ': return resolveSae(c);
    case 'まで': return resolveMade(c);
    case 'より': return resolveYori(c);
    case 'ので':
      return resolveConjunctive(c, 'reason', '「ので」陈述客观原因，语气比「から」柔和。', '原因（客观）', '结果');
    case 'けど':
    case 'けれど':
    case 'けれども':
      return resolveConjunctive(c, 'contrast', '连接语义相反的前后两句。', '前句', '转折后的后句');
    case 'し':
      return resolveConjunctive(c, 'reasons', '并列举出若干理由，暗示还有其他。', '理由之一', '结论');
    case 'ば':
      return resolveConjunctive(c, 'conditional', '接假定形，表示「如果……就……」。', '假定条件', '结果');
    case 'たら':
      return resolveConjunctive(c, 'conditional', '前项完成后后项才成立。', '条件', '结果');
    case 'なら':
      return resolveConjunctive(c, 'topic-condition', '承接话题作条件，后项多为建议或判断。', '话题条件', '建议／判断');
    case 'ても':
      return resolveConjunctive(c, 'concession', '即使前项成立，后项依然不变。', '让步条件', '结论');
    case 'ながら':
      return resolveConjunctive(c, 'simultaneous', '接动词连用形，表示同一主体同时进行两个动作（后项为主）。', '附带动作', '主要动作');
    case 'つつ':
      return resolveConjunctive(c, 'simultaneous', '书面语的「ながら」。', '附带动作', '主要动作');
    case 'ものの':
      return resolveConjunctive(c, 'contrast', '书面语的逆接。', '前提', '不如预期的结果');
    case 'たり':
      return resolveConjunctive(c, 'list-actions', '从若干动作中举例，常成对使用。', '列举的动作', '总括谓语');
    case 'とか':
      return resolveConjunctive(c, 'examples', '口语的部分列举。', '列举项', '谓语');
    case 'や':
      return { key: 'partial-list', reason: '举出若干代表项，暗示还有其他同类。', beforeRole: '列举项', afterRole: '列举项', afterTarget: c.next };
    case 'て':
      return resolveConjunctive(c, 'sequence', '把前后动作按顺序连接。', '前项动作', '后项动作');
    case 'ね':
    case 'よ':
    case 'ぞ':
    case 'なあ':
    case 'わ':
    case 'さ':
    case 'かしら':
    case 'かな':
    case 'とも':
      return { key: '', reason: '位于句末，为整句附加语气。', ...FINAL_ROLE };
    default:
      return { key: '', reason: '按该助词的首选义项理解。' };
  }
}

/* ────────────────────────────── 组装 ParticleInfo ────────────────────────────── */

function arg(w: Word | undefined, role: string): ParticleArgument | undefined {
  if (!w || !role) return undefined;
  return { wordId: w.id, surface: w.surface, role };
}

function categoryOf(word: Word, fallback: ParticleCategory): ParticleCategory {
  if (word.posJa === '名詞') return 'other'; // 准体助词「の」
  const detail = word.subTokens[0]?.posDetail[0] ?? '';
  if (detail === '格助詞' && word.subTokens[0]?.posDetail[1] === '引用') return 'quotation';
  return JA_CATEGORY_MAP[detail] ?? fallback;
}

/**
 * 为 words 中所有助词单位填充 particle 字段（就地修改）。
 */
export function annotateParticles(words: Word[]): void {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.isParticle) continue;

    const c = buildCtx(words, i);
    const def = getParticleDef(w.surface) ?? fallbackDef(w.surface, toRomaji(w.reading || w.surface), categoryOf(w, 'other'));
    const category = categoryOf(w, def.category);
    const categoryLabel = w.posJa === '名詞' ? '准体助词（名词化）' : CATEGORY_LABEL[category];

    const res = resolve(c);

    /* 复合助词：与前一个助词连写时，整体另有含义 */
    let compoundSense: ParticleSense | undefined;
    let compoundNote = '';
    const prevWord = c.sentence[c.sentence.indexOf(w) - 1];
    // 前一个「で」已被判为断定助动词时，「では」不是格助词的主题化复合形
    const prevIsCopula = prevWord?.particle?.sense.key === 'copula-negation';
    if (prevWord?.isParticle && !prevIsCopula) {
      const cd = COMPOUND_MAP.get(`${prevWord.surface}\u0000${w.surface}`);
      if (cd) {
        compoundSense = cd.sense;
        compoundNote = `与前面的「${prevWord.surface}」连写成复合助词「${cd.surface}」（${cd.romaji}）。`;
      }
    }
    const nextWord = c.sentence[c.sentence.indexOf(w) + 1];
    if (!compoundSense && nextWord?.isParticle) {
      const cd = COMPOUND_MAP.get(`${w.surface}\u0000${nextWord.surface}`);
      if (cd) compoundNote = `与后面的「${nextWord.surface}」连写成复合助词「${cd.surface}」（${cd.romaji}）。`;
    }

    const allSenses = compoundSense ? [compoundSense, ...def.senses] : def.senses;
    const sense =
      (compoundSense ?? def.senses.find((x) => x.key === res.key)) ?? def.senses[0] ?? {
        key: 'generic',
        label: categoryLabel,
        detail: `「${w.surface}」的用法尚未收录。`,
      };

    const beforeRole = res.beforeRole ?? '前接成分';
    const afterRole = res.afterRole ?? '';
    const afterWord = res.afterTarget ?? c.predicate;

    const before = arg(c.prev, beforeRole);
    const after = arg(afterWord, afterRole);

    let structureNote = res.structure ?? '';
    if (!structureNote) {
      if (before && after) {
        structureNote = `「${before.surface} ${w.surface} ${after.surface}」：「${before.surface}」是${beforeRole}，「${after.surface}」是${afterRole}。`;
      } else if (before) {
        structureNote = `「${before.surface} ${w.surface}」：「${before.surface}」是${beforeRole}，「${w.surface}」为整句附加「${sense.label}」的作用。`;
      } else {
        structureNote = `「${w.surface}」在此表示${sense.label}。`;
      }
    }
    if (compoundNote) structureNote += compoundNote;

    w.particle = {
      particle: w.surface,
      romaji: def.romaji,
      category,
      categoryLabel,
      sense,
      allSenses,
      before,
      after,
      structureNote,
      reason: compoundSense ? `${compoundNote}${res.reason}` : res.reason,
    };
  }
}
