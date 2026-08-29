/**
 * 活用还原：把「词干 + 附属成分链」逆推回辞書形，并给出中文形态名与语法说明。
 *
 * 核心观察：kuromoji 给出的每个附属成分的 surface 恰好就是它「被下一个成分活用后」的形态，
 * 而它自己的 basic_form 是辞書形。于是
 *     第 k 级的辞書形 = surface[0..k-1] 拼接 + lemma[k]
 * 依次求出 k = headCount..n-1 就得到完整的还原链，反向即为「表层 → 辞書形」。
 * 例：読ま|せ|られ|なかっ|た
 *   k=1 読ま+せる      = 読ませる
 *   k=2 読ませ+られる  = 読ませられる
 *   k=3 読ませられ+ない = 読ませられない
 *   k=4 読ませられなかっ+た = 読ませられなかった
 */
import type { InflectionInfo, SubToken } from '../../shared/types.ts';

export interface RoleResult {
  /** 中文作用名，写入 SubToken.role */
  role: string;
  /** 参与 form 组合的语法要素；缺省表示不进入 features */
  feature?: string;
  /** 中文语法说明 */
  explain?: string;
}

/* ────────────────────────────── 附属成分知识表 ────────────────────────────── */

/** 助動詞 / 動詞接尾 */
const AUX_TABLE: Record<string, RoleResult> = {
  せる: { role: '使役', feature: '使役', explain: '「せる」接五段动词未然形，表示让／使某人做某事' },
  させる: { role: '使役', feature: '使役', explain: '「させる」接一段·カ变动词未然形，表示让／使某人做某事' },
  しめる: { role: '使役（文语）', feature: '使役', explain: '文言色彩的使役助动词' },
  れる: { role: '被动/可能/尊他', feature: '被动·可能', explain: '「れる」接五段动词未然形，兼表被动、可能、自发与尊敬' },
  られる: { role: '被动/可能/尊他', feature: '被动·可能', explain: '「られる」接一段·カ变动词未然形，兼表被动、可能、自发与尊敬' },
  ない: { role: '否定', feature: '否定', explain: '「ない」接未然形，表示否定' },
  ぬ: { role: '否定（文语）', feature: '否定', explain: '文言否定助动词，相当于「ない」' },
  ん: { role: '否定（口语）', feature: '否定', explain: '「ぬ」的口语形，如「分かりません」' },
  た: { role: '过去/完了', feature: '过去', explain: '「た」接连用形，表示动作已完成或过去发生' },
  ます: { role: '敬体', feature: '敬体', explain: '「ます」接连用形，构成礼貌体（丁寧語）' },
  です: { role: '断定·敬体', feature: '敬体', explain: '「です」是礼貌的断定助动词' },
  だ: { role: '断定', feature: '断定', explain: '「だ」是简体的断定助动词' },
  う: { role: '意志/推量', feature: '意志·推量', explain: '「う」接未然形（ウ音便），表示意志或推测' },
  よう: { role: '意志/推量', feature: '意志·推量', explain: '「よう」接一段动词未然形，表示意志或劝诱' },
  まい: { role: '否定意志/否定推量', feature: '否定意志', explain: '「まい」表示不打算做，或推测不会发生' },
  たい: { role: '愿望', feature: '愿望', explain: '「たい」接连用形，表示说话人自身的愿望' },
  たがる: { role: '愿望（第三人称）', feature: '愿望', explain: '「たがる」描述第三者表现出来的愿望' },
  らしい: { role: '推定', feature: '推定', explain: '「らしい」根据客观依据做推断' },
  ようだ: { role: '比况/推定', feature: '推定', explain: '「ようだ」表示比喻或主观推断' },
  みたいだ: { role: '比况（口语）', feature: '推定', explain: '「みたいだ」是「ようだ」的口语形' },
  そうだ: { role: '样态/传闻', feature: '样态', explain: '接连用形表样态「看起来」，接终止形表传闻「听说」' },
  べし: { role: '应当', feature: '当为', explain: '文言助动词，表示理应如此' },
  ごとし: { role: '如同', feature: '比况', explain: '文言助动词，相当于「ようだ」' },
  やがる: { role: '轻蔑', feature: '轻蔑', explain: '粗俗语，对动作者表示厌恶' },
};

/** 補助動詞（動詞,非自立） */
const AUX_VERB_TABLE: Record<string, RoleResult> = {
  いる: { role: '进行/结果状态', feature: '进行', explain: '「〜ている」表示动作进行中或动作结果的持续状态' },
  おる: { role: '进行（谦让/方言）', feature: '进行', explain: '「〜ておる」是「〜ている」的谦让或方言形式' },
  ある: { role: '状态存续', feature: '存续', explain: '「〜てある」表示有人为动作留下的状态' },
  しまう: { role: '完成/遗憾', feature: '完成', explain: '「〜てしまう」表示彻底完成，或含遗憾、后悔' },
  ちゃう: { role: '完成/遗憾（口语）', feature: '完成', explain: '「〜てしまう」的口语缩约形' },
  じゃう: { role: '完成/遗憾（口语）', feature: '完成', explain: '「〜でしまう」的口语缩约形' },
  おく: { role: '预先准备', feature: '预备', explain: '「〜ておく」表示为将来预先做好' },
  とく: { role: '预先准备（口语）', feature: '预备', explain: '「〜ておく」的口语缩约形' },
  みる: { role: '尝试', feature: '尝试', explain: '「〜てみる」表示试着做做看' },
  くる: { role: '趋向（由远及近）', feature: '趋向·来', explain: '「〜てくる」表示动作向说话人靠近，或状态逐渐出现' },
  いく: { role: '趋向（渐行渐远）', feature: '趋向·去', explain: '「〜ていく」表示动作离说话人远去，或状态今后持续变化' },
  ゆく: { role: '趋向（渐行渐远）', feature: '趋向·去', explain: '「〜てゆく」是「〜ていく」的书面形' },
  もらう: { role: '授受（受益·内向）', feature: '受益', explain: '「〜てもらう」表示请别人为自己做，自己是受益方' },
  いただく: { role: '授受（受益·谦让）', feature: '受益', explain: '「〜ていただく」是「〜てもらう」的谦让形' },
  くれる: { role: '授受（内向）', feature: '受益', explain: '「〜てくれる」表示别人主动为我（方）做，含感谢之意' },
  くださる: { role: '授受（内向·尊敬）', feature: '受益', explain: '「〜てくださる」是「〜てくれる」的尊敬形' },
  あげる: { role: '授受（外向）', feature: '施与', explain: '「〜てあげる」表示我（方）为别人做' },
  やる: { role: '授受（外向·随意）', feature: '施与', explain: '「〜てやる」用于对下位者，或表示逞强' },
  さしあげる: { role: '授受（外向·谦让）', feature: '施与', explain: '「〜てさしあげる」是「〜てあげる」的谦让形' },
  ください: { role: '请求', feature: '请求', explain: '「〜てください」表示请对方做某事' },
  ほしい: { role: '希望（他人做）', feature: '希望', explain: '「〜てほしい」表示希望别人做某事' },
};

/** 形容詞,非自立 */
const AUX_ADJ_TABLE: Record<string, RoleResult> = {
  ない: { role: '否定', feature: '否定', explain: '补助形容词「ない」，接て形或形容词连用形表示否定' },
  ほしい: { role: '希望（他人做）', feature: '希望', explain: '「〜てほしい」表示希望别人做某事' },
  やすい: { role: '容易', feature: '容易', explain: '「〜やすい」表示容易做到' },
  にくい: { role: '难以', feature: '难以', explain: '「〜にくい」表示不容易做到' },
  づらい: { role: '难以（心理）', feature: '难以', explain: '「〜づらい」侧重心理上的为难' },
  がたい: { role: '难以（书面）', feature: '难以', explain: '「〜がたい」是书面语的「难以」' },
  よい: { role: '易于', feature: '容易', explain: '「〜よい／〜いい」表示做起来舒适' },
};

/** 名詞・動詞接尾 */
const SUFFIX_TABLE: Record<string, RoleResult> = {
  さ: { role: '名词化（程度）', feature: '名词化', explain: '「〜さ」把形容词变成表示程度的名词' },
  み: { role: '名词化（性状）', feature: '名词化', explain: '「〜み」把形容词变成表示性质、感觉的名词' },
  方: { role: '名词化（方法）', feature: '名词化', explain: '「〜方」接动词连用形，表示做某事的方法' },
  がる: { role: '表现出（第三人称）', feature: '表征', explain: '「〜がる」描述第三者表现出的情绪' },
  すぎる: { role: '过度', feature: '过度', explain: '「〜すぎる」表示程度超过合适范围' },
  っぽい: { role: '倾向', feature: '倾向', explain: '「〜っぽい」表示带有某种倾向' },
  たち: { role: '复数', explain: '「〜たち」表示复数' },
  ら: { role: '复数', explain: '「〜ら」表示复数（较随意）' },
  ども: { role: '复数（谦称）', explain: '「〜ども」是谦逊的复数后缀' },
  さん: { role: '敬称', explain: '「〜さん」是通用敬称' },
  様: { role: '敬称（郑重）', explain: '「〜様」是郑重的敬称' },
  君: { role: '敬称（对下/同辈）', explain: '「〜君」多用于男性同辈或下级' },
  ちゃん: { role: '昵称', explain: '「〜ちゃん」是亲昵的称呼' },
  中: { role: '范围/进行中', explain: '「〜中」表示范围之内或正在进行' },
  的: { role: '形容词化', explain: '「〜的」把名词变成な形容词性成分' },
};

/** kuromoji 活用形 → 中文形态名（空串表示基本形，不计入 features） */
const CONJ_FORM_LABEL: Record<string, string> = {
  基本形: '',
  '基本形-促音便': '',
  音便基本形: '',
  仮定形: '假定形',
  仮定縮約１: '假定缩约形',
  仮定縮約２: '假定缩约形',
  未然形: '未然形',
  未然ウ接続: '未然形',
  未然ヌ接続: '未然形',
  未然レル接続: '未然形',
  未然特殊: '未然形',
  連用形: '连用形',
  連用タ接続: '连用形',
  連用テ接続: '连用形',
  連用デ接続: '连用形',
  連用ゴザイ接続: '连用形',
  体言接続: '连体形',
  体言接続特殊: '连体形',
  体言接続特殊２: '连体形',
  ガル接続: '词干',
  命令ｅ: '命令形',
  命令ｉ: '命令形',
  命令ｒｏ: '命令形',
  命令ｙｏ: '命令形',
  体言接続用: '连体形',
  文語基本形: '文语基本形',
  '': '',
  '*': '',
};

/* ────────────────────────────── 角色标注 ────────────────────────────── */

/** 判断某个附属成分的语法作用 */
export function classifySuffix(sub: SubToken, prevFeatures: string[], isLast: boolean): RoleResult {
  const lemma = sub.lemma && sub.lemma !== '*' ? sub.lemma : sub.surface;

  // 接続助詞 て/で：て形。后面若还有補助動詞，它只是连接件，不单独计入 features
  if (sub.posJa === '助詞') {
    return {
      role: 'て形',
      feature: isLast ? 'て形' : undefined,
      explain: '「て／で」把动词变成中顿的て形，用于连接后续成分',
    };
  }

  if (sub.posJa === '動詞' && sub.posDetail[0] === '非自立') {
    // 「〇てください」：kuromoji 给的辞書形是くださる，但命令形在这里就是请求表达
    if ((lemma === 'くださる' || lemma === 'なさる') && sub.conjForm.startsWith('命令')) {
      return { role: '请求（敬语）', feature: '请求', explain: '「〇てください」是礼貌地请对方做某事' };
    }
    const hit = AUX_VERB_TABLE[lemma];
    if (hit) return hit;
    return { role: '补助动词', feature: '补助', explain: `补助动词「${lemma}」为前面的て形补充语义` };
  }

  if (sub.posJa === '形容詞' && sub.posDetail[0] === '非自立') {
    const hit = AUX_ADJ_TABLE[lemma];
    if (hit) return hit;
    return { role: '补助形容词', feature: '补助', explain: `补助形容词「${lemma}」` };
  }

  if (sub.posJa === '助動詞' || (sub.posJa === '動詞' && sub.posDetail[0] === '接尾')) {
    const hit = AUX_TABLE[lemma];
    if (hit) {
      // 「せる／させる」之后的「れる／られる」只能是被动，可排除可能与尊敬
      if ((lemma === 'れる' || lemma === 'られる') && prevFeatures.includes('使役')) {
        return { role: '被动', feature: '被动', explain: '紧接使役助动词，构成「使役被动」——被迫做某事' };
      }
      // 「そうだ」：接终止形是传闻，接连用形/词干是样态
      if (lemma === 'そうだ' || lemma === 'そう') {
        return hit;
      }
      return hit;
    }
    return { role: '助动词', feature: '助动词', explain: `助动词「${lemma}」` };
  }

  if (sub.posJa === '名詞' && sub.posDetail[0] === '接尾') {
    const hit = SUFFIX_TABLE[lemma];
    if (hit) return hit;
    if (sub.posDetail[1] === '助数詞') return { role: '量词', explain: `量词「${lemma}」` };
    return { role: '接尾词', explain: `接尾词「${lemma}」` };
  }

  const hit = SUFFIX_TABLE[lemma] ?? AUX_TABLE[lemma];
  if (hit) return hit;
  return { role: '附属成分' };
}

/* ────────────────────────────── 形态名组合 ────────────────────────────── */

/** 相邻要素的惯用合并，让形态名读起来像语法书里的说法 */
const FEATURE_MERGES: [string, string, string][] = [
  ['使役', '被动', '使役被动'],
  ['使役', '被动·可能', '使役被动'],
  ['否定', '过去', '过去否定'],
  ['愿望', '过去', '过去愿望'],
  ['进行', '过去', '过去进行'],
  ['否定', '敬体', '否定·敬体'],
];

function mergeFeatures(features: string[]): string[] {
  const out = [...features];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i + 1 < out.length; i++) {
      const rule = FEATURE_MERGES.find(([a, b]) => a === out[i] && b === out[i + 1]);
      if (rule) {
        out.splice(i, 2, rule[2]);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/* ────────────────────────────── 主入口 ────────────────────────────── */

export interface InflectOptions {
  /** 已按顺序排列的内部词素（本函数会写入 role） */
  subTokens: SubToken[];
  /** 构成词干的 token 数量：普通词 1；サ变「勉強+する」2；「お+弁当」2 */
  headCount: number;
  /** 词干的辞書形 */
  baseLemma: string;
  /** 该词单位是否可能有活用（名词、助词等传 false） */
  inflectable: boolean;
}

/**
 * 标注每个词素的语法作用，并（在可活用时）产出还原链。
 * 即使返回 undefined，subTokens 的 role 也已经写好。
 */
export function annotateAndInflect(opts: InflectOptions): InflectionInfo | undefined {
  const { subTokens, headCount, baseLemma, inflectable } = opts;
  if (subTokens.length === 0) return undefined;

  const features: string[] = [];
  const explains: string[] = [];

  for (let i = headCount; i < subTokens.length; i++) {
    const sub = subTokens[i];
    const res = classifySuffix(sub, features, i === subTokens.length - 1);
    sub.role = res.role;
    if (res.feature) features.push(res.feature);
    if (res.explain && !explains.includes(res.explain)) explains.push(res.explain);
  }

  // 末尾词素自身的活用形（如「〜なければ」的仮定形、「読め」的命令形）
  const last = subTokens[subTokens.length - 1];
  const tailForm = CONJ_FORM_LABEL[last.conjForm] ?? '';
  // 请求形本身就是命令形，不再重复标注
  if (tailForm && tailForm !== '词干' && !(tailForm === '命令形' && features.includes('请求'))) {
    features.push(tailForm);
  }

  if (!inflectable) return undefined;

  /* 还原链 */
  const surfaces = subTokens.map((t) => t.surface);
  const full = surfaces.join('');
  const chain: string[] = [baseLemma];
  for (let k = headCount; k < subTokens.length; k++) {
    const lemma = subTokens[k].lemma && subTokens[k].lemma !== '*' ? subTokens[k].lemma : subTokens[k].surface;
    chain.push(surfaces.slice(0, k).join('') + lemma);
  }
  const steps: string[] = [];
  for (let i = chain.length - 1; i >= 0; i--) {
    if (steps[steps.length - 1] !== chain[i]) steps.push(chain[i]);
  }
  if (steps[0] !== full) steps.unshift(full);

  const merged = mergeFeatures(features);
  const form = merged.length > 0 ? merged.join('·') : '辞書形';

  /* 语法说明 */
  const pieces: string[] = [];
  const headSurface = surfaces.slice(0, headCount).join('');
  const headConj = CONJ_FORM_LABEL[subTokens[headCount - 1]?.conjForm] ?? '';
  pieces.push(headConj ? `词干「${baseLemma}」的${headConj}「${headSurface}」` : `「${baseLemma}」`);
  for (let i = headCount; i < subTokens.length; i++) {
    const sub = subTokens[i];
    const lemma = sub.lemma && sub.lemma !== '*' ? sub.lemma : sub.surface;
    pieces.push(`「${sub.surface}」（${lemma}／${sub.role}）`);
  }
  const structure = pieces.join(' ＋ ');
  const notes =
    subTokens.length > headCount
      ? `构成：${structure}。${explains.join('；')}${explains.length > 0 ? '。' : ''}整体为${form}。`
      : tailForm
        ? `「${baseLemma}」的${tailForm}，未接其他附属成分。`
        : `「${baseLemma}」保持辞書形（基本形），没有附加语法要素。`;

  return { form, steps, notes, features: merged };
}
