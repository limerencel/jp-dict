/**
 * 前后端共享的数据契约。
 * 这是各模块之间唯一的耦合点，修改时请同步 server/ 与 web/ 两侧。
 */

/* ────────────────────────────── 词典 ────────────────────────────── */

/** Yomitan 结构化内容节点（term_bank v3 的 structured-content）。 */
export type SCNode = string | number | SCNode[] | SCElement;

export interface SCElement {
  tag: string;
  content?: SCNode;
  data?: Record<string, string>;
  lang?: string;
  style?: Record<string, string | number>;
  /** a 标签 */
  href?: string;
  /** img 标签 */
  path?: string;
  width?: number;
  height?: number;
  title?: string;
  alt?: string;
  description?: string;
  collapsible?: boolean;
  collapsed?: boolean;
  background?: boolean;
  appearance?: string;
  imageRendering?: string;
  sizeUnits?: string;
  /** table 相关 */
  colSpan?: number;
  rowSpan?: number;
  [key: string]: unknown;
}

export type GlossaryNode =
  | string
  | { type: 'text'; text: string }
  | { type: 'image'; path: string; width?: number; height?: number; title?: string; description?: string; [k: string]: unknown }
  | { type: 'structured-content'; content: SCNode }
  /** MDict(.mdx) 词典的原生 HTML。已在导入时服务端消毒，渲染时需放在 `.mdx-dict-<dictId>` 容器内 */
  | { type: 'html'; html: string };

export interface TagInfo {
  name: string;
  category: string;
  order: number;
  notes: string;
  score: number;
}

export interface DictEntry {
  dictId: number;
  dictTitle: string;
  /** 词典自身优先级，越大越靠前 */
  dictPriority: number;
  term: string;
  reading: string;
  /** 释义级别的标签，如「名」「他サ」 */
  definitionTags: TagInfo[];
  /** 词条级别的标签，如「常用」 */
  termTags: TagInfo[];
  /** Yomitan 词形变化规则标识：v1 / v5 / vs / vk / adj-i ... */
  rules: string[];
  score: number;
  sequence: number;
  glossary: GlossaryNode[];
  /** 命中该词条时用到的还原路径，如 ['食べなかった','食べない','食べる'] */
  matchedVia?: string[];
  /** 命中时消耗的原文长度（字符数），用于最长匹配排序 */
  matchedLength?: number;
}

export interface KanjiEntry {
  dictId: number;
  dictTitle: string;
  character: string;
  onyomi: string[];
  kunyomi: string[];
  tags: TagInfo[];
  meanings: string[];
  stats: Record<string, string>;
}

export interface PitchAccent {
  dictTitle: string;
  reading: string;
  /** 下降位置，0 = 平板型 */
  position: number;
  nasal?: number[];
  devoice?: number[];
  tags?: string[];
  /** 型名：平板 / 頭高 / 中高 / 尾高 */
  patternLabel: string;
}

export interface FrequencyInfo {
  dictTitle: string;
  reading?: string;
  value: number;
  displayValue: string;
}

export type DictionaryKind = 'term' | 'kanji' | 'frequency' | 'pitch' | 'mixed';

/** 词典源文件格式 */
export type DictionarySource = 'yomitan' | 'mdict';

export interface DictionaryMeta {
  id: number;
  title: string;
  revision: string;
  format: number;
  author?: string;
  url?: string;
  description?: string;
  attribution?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  /** rank-based 频率词典数值越小越常用 */
  frequencyMode?: 'occurrence-based' | 'rank-based';
  kind: DictionaryKind;
  termCount: number;
  kanjiCount: number;
  metaCount: number;
  enabled: boolean;
  /** 展示与排序优先级，越大越靠前 */
  priority: number;
  /** 源文件名 */
  fileName: string;
  fileSize: number;
  importedAt: string;
  /** 源格式：Yomitan zip 或 MDict mdx */
  source: DictionarySource;
  /**
   * 该词典自带样式表（MDict 的配套 .css）。
   * true 时前端应拉取 `/api/dictionaries/<id>/style.css` 并注入页面。
   * 服务端已把所有选择器作用域化到 `.mdx-dict-<id>`。
   */
  hasStyle: boolean;
}

/* ────────────────────────────── 分析 ────────────────────────────── */

/** 归一化后的粗粒度词性 */
export type Pos =
  | 'noun'
  | 'pronoun'
  | 'propernoun'
  | 'number'
  | 'verb'
  | 'i-adjective'
  | 'na-adjective'
  | 'adverb'
  | 'prenominal'
  | 'conjunction'
  | 'interjection'
  | 'particle'
  | 'auxiliary'
  | 'prefix'
  | 'suffix'
  | 'counter'
  | 'symbol'
  | 'whitespace'
  | 'other';

/** kuromoji 原始词素，保留在合并单位内部供「拆解」视图使用 */
export interface SubToken {
  surface: string;
  /** 平假名读音 */
  reading: string;
  lemma: string;
  /** kuromoji 词性（日文），如「動詞」 */
  posJa: string;
  posDetail: string[];
  conjType: string;
  conjForm: string;
  /** 该词素在语法链中的作用，如「使役」「受身」「过去」「て形」 */
  role?: string;
}

export interface FuriganaSegment {
  text: string;
  /** 需要注音时给出假名；纯假名段落为 undefined */
  ruby?: string;
}

/** 一个「词单位」：由若干 kuromoji 词素合并而成，是 UI 的最小交互单元 */
export interface Word {
  id: number;
  sentenceIndex: number;
  /** 在原文中的字符偏移 [start, end) */
  start: number;
  end: number;
  surface: string;
  /** 整个单位的平假名读音 */
  reading: string;
  furigana: FuriganaSegment[];
  /** 辞書形 */
  lemma: string;
  lemmaReading: string;
  pos: Pos;
  /** 中文词性标签，如「动词（一段）」 */
  posLabel: string;
  posJa: string;
  isParticle: boolean;
  /** 内部词素拆解，长度 > 1 时 UI 需展示「由 N 个成分构成」 */
  subTokens: SubToken[];
  /** 活用还原链 */
  inflection?: InflectionInfo;
  /** 仅助词单位有值 */
  particle?: ParticleInfo;
  /** hover 用的精简释义（已按词典优先级排序，最多 3 条） */
  brief: BriefSense[];
  /** 是否还有更多释义需要点击查看 */
  hasMore: boolean;
  pitch: PitchAccent[];
  frequency: FrequencyInfo[];
  /** 无词典命中时为 true，UI 应弱化显示 */
  unknown: boolean;
}

export interface BriefSense {
  dictTitle: string;
  term: string;
  reading: string;
  tags: string[];
  /** 已扁平化为纯文本的释义，便于 tooltip 直接显示 */
  text: string;
}

export interface InflectionInfo {
  /** 中文形态名，如「过去否定・敬体」 */
  form: string;
  /** 还原步骤：由表层到辞書形 */
  steps: string[];
  /** 语法说明 */
  notes: string;
  /** 拆出的语法要素：['使役','受身','过去'] */
  features: string[];
}

export type ParticleCategory =
  | 'case'        // 格助詞
  | 'binding'     // 係助詞
  | 'adverbial'   // 副助詞
  | 'conjunctive' // 接続助詞
  | 'parallel'    // 並立助詞
  | 'final'       // 終助詞
  | 'quotation'   // 引用
  | 'other';

export interface ParticleSense {
  key: string;
  label: string;
  detail: string;
  example?: string;
  exampleTranslation?: string;
}

export interface ParticleArgument {
  wordId: number;
  surface: string;
  /** 该成分承担的角色，如「主题」「动作对象」「谓语」 */
  role: string;
}

export interface ParticleInfo {
  particle: string;
  romaji: string;
  category: ParticleCategory;
  categoryLabel: string;
  /** 当前语境下判定的义项 */
  sense: ParticleSense;
  /** 该助词的全部义项，供 Panel 展示 */
  allSenses: ParticleSense[];
  /** 助词前接成分 */
  before?: ParticleArgument;
  /** 助词后接/所修饰的成分 */
  after?: ParticleArgument;
  /** 一句话结构说明，如「「私 は 学生」：私 是主题，学生 是陈述内容」 */
  structureNote: string;
  /** 判定依据，便于用户理解为何选了这个义项 */
  reason?: string;
}

export interface Sentence {
  index: number;
  start: number;
  end: number;
  text: string;
  wordIds: number[];
}

export interface AnalysisResult {
  text: string;
  sentences: Sentence[];
  words: Word[];
  /** 参与本次分析的词典 */
  dictionaries: Pick<DictionaryMeta, 'id' | 'title' | 'kind' | 'priority'>[];
  stats: {
    chars: number;
    words: number;
    sentences: number;
    /** 未命中词典的词数 */
    unknownWords: number;
    ms: number;
  };
  /** 非致命警告，如「文本被截断」 */
  warnings: string[];
}

/* ────────────────────────────── API ────────────────────────────── */

export interface AnalyzeRequest {
  text: string;
}

export interface LookupRequest {
  /** 表层形 */
  surface: string;
  /** 辞書形，优先用于查询 */
  lemma?: string;
  reading?: string;
}

export interface LookupResponse {
  query: string;
  entries: DictEntry[];
  kanji: KanjiEntry[];
  pitch: PitchAccent[];
  frequency: FrequencyInfo[];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** 当前分析的整段文本，作为背景 */
  context?: {
    fullText?: string;
    sentence?: string;
    focusWord?: {
      surface: string;
      reading: string;
      lemma: string;
      posLabel: string;
      brief: string[];
    };
  };
}

export interface ImportProgress {
  phase: 'scan' | 'read' | 'parse' | 'write' | 'index' | 'done' | 'error';
  file: string;
  message: string;
  /** 0..1，未知时为 -1 */
  progress: number;
}

export interface ApiError {
  error: string;
  detail?: string;
}

/* ────────────────────────────── 翻译 ────────────────────────────── */

export interface TranslateRequest {
  /** 一次可提交多条（通常按句拆分），顺序与返回一一对应 */
  texts: string[];
  /** 目标语言，默认取服务端配置（zh-CN） */
  target?: string;
  /** 源语言，默认 ja */
  source?: string;
  /** 指定服务商，默认由服务端自动选择 */
  provider?: string;
}

export interface TranslateResponse {
  provider: string;
  providerLabel: string;
  target: string;
  translations: string[];
  cached: boolean[];
  /** 主服务商失败并自动降级时的说明 */
  notice?: string;
}

export interface TranslateProviderInfo {
  id: string;
  label: string;
  available: boolean;
  needsKey: boolean;
  hint: string;
}

export interface TranslateConfig {
  providers: TranslateProviderInfo[];
  /** 当前生效的服务商 id */
  active: string;
  /** 默认目标语言 */
  target: string;
  targets: { code: string; label: string }[];
}
