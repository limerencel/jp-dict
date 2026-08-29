/**
 * 翻译服务商适配层。
 *
 * 每个 provider 把「一批文本」翻成目标语言。DeepL / Microsoft / LibreTranslate / AI
 * 原生支持批量；Google 免费接口与 MyMemory 只能逐条请求，由上层做并发控制。
 */
import { AI, TRANSLATE } from '../config.ts';

export type ProviderId = 'deepl' | 'microsoft' | 'google' | 'ai' | 'libre' | 'mymemory';

export interface Provider {
  id: ProviderId;
  label: string;
  /** 是否需要 API Key */
  needsKey: boolean;
  /** 当前环境下是否可用 */
  available(): boolean;
  /** 未配置时给用户看的提示 */
  hint: string;
  /** 一次能吃下的最大条目数；0 表示不支持批量（上层逐条并发） */
  batchSize: number;
  translate(texts: string[], source: string, target: string, signal: AbortSignal): Promise<string[]>;
}

class TranslateError extends Error {
  // 注意：不能用构造函数参数属性。`npm start` 走 Node 原生的类型擦除，它只删类型不生成代码。
  readonly provider: ProviderId;

  constructor(provider: ProviderId, message: string) {
    super(message);
    this.name = 'TranslateError';
    this.provider = provider;
  }
}

async function fetchJson(url: string, init: RequestInit, provider: ProviderId): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new TranslateError(provider, `HTTP ${res.status}${body ? ` ${body.slice(0, 300)}` : ''}`);
  }
  return res.json();
}

/* ─────────────────────────── 语言代码映射 ─────────────────────────── */

/** 内部统一用 BCP-47 风格（zh-CN / zh-TW / en / ja / ko），各家再各自转换 */
const DEEPL_LANG: Record<string, string> = {
  'zh-CN': 'ZH-HANS', 'zh-TW': 'ZH-HANT', en: 'EN-US', ja: 'JA', ko: 'KO', fr: 'FR', de: 'DE', es: 'ES', ru: 'RU',
};
const MS_LANG: Record<string, string> = {
  'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru',
};
const LIBRE_LANG: Record<string, string> = {
  'zh-CN': 'zh', 'zh-TW': 'zt', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru',
};
export const LANG_LABEL: Record<string, string> = {
  'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English', ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español', ru: 'Русский',
};

/* ─────────────────────────── DeepL ─────────────────────────── */

const deepl: Provider = {
  id: 'deepl',
  label: 'DeepL',
  needsKey: true,
  hint: '在 .env 设置 DEEPL_API_KEY（免费版每月 50 万字符）',
  batchSize: 50,
  available: () => Boolean(TRANSLATE.deeplKey),
  async translate(texts, source, target, signal) {
    // 免费版 key 以 :fx 结尾，走 api-free 域名
    const host = TRANSLATE.deeplKey.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    const json = (await fetchJson(
      `${host}/v2/translate`,
      {
        method: 'POST',
        headers: { authorization: `DeepL-Auth-Key ${TRANSLATE.deeplKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          text: texts,
          source_lang: source === 'auto' ? undefined : source.toUpperCase(),
          target_lang: DEEPL_LANG[target] ?? 'ZH-HANS',
        }),
        signal,
      },
      'deepl',
    )) as { translations?: { text?: string }[] };
    return texts.map((_, i) => json.translations?.[i]?.text ?? '');
  },
};

/* ─────────────────────────── Microsoft ─────────────────────────── */

const microsoft: Provider = {
  id: 'microsoft',
  label: 'Microsoft 翻译',
  needsKey: true,
  hint: '在 .env 设置 MS_TRANSLATOR_KEY 和 MS_TRANSLATOR_REGION（免费层每月 200 万字符）',
  batchSize: 25,
  available: () => Boolean(TRANSLATE.msKey),
  async translate(texts, source, target, signal) {
    const params = new URLSearchParams({ 'api-version': '3.0', to: MS_LANG[target] ?? 'zh-Hans' });
    if (source !== 'auto') params.set('from', source);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'Ocp-Apim-Subscription-Key': TRANSLATE.msKey,
    };
    if (TRANSLATE.msRegion) headers['Ocp-Apim-Subscription-Region'] = TRANSLATE.msRegion;
    const json = (await fetchJson(
      `${TRANSLATE.msEndpoint}/translate?${params}`,
      { method: 'POST', headers, body: JSON.stringify(texts.map((t) => ({ Text: t }))), signal },
      'microsoft',
    )) as { translations?: { text?: string }[] }[];
    return texts.map((_, i) => json[i]?.translations?.[0]?.text ?? '');
  },
};

/* ─────────────────────────── Google（免费 gtx 端点）─────────────────────────── */

const google: Provider = {
  id: 'google',
  label: 'Google 翻译（免费）',
  needsKey: false,
  hint: '无需配置。使用 translate.googleapis.com 的公开端点，国内网络可能无法访问',
  batchSize: 0,
  available: () => true,
  async translate(texts, source, target, signal) {
    const one = async (text: string): Promise<string> => {
      const params = new URLSearchParams({
        client: 'gtx',
        sl: source === 'auto' ? 'auto' : source,
        tl: target,
        dt: 't',
        q: text,
      });
      const json = (await fetchJson(
        `https://translate.googleapis.com/translate_a/single?${params}`,
        { signal, headers: { 'user-agent': 'Mozilla/5.0' } },
        'google',
      )) as [[[string, string]] | null, ...unknown[]];
      const segments = json[0];
      if (!Array.isArray(segments)) return '';
      return segments.map((s) => (Array.isArray(s) ? s[0] : '')).join('');
    };
    return Promise.all(texts.map(one));
  },
};

/* ─────────────────────────── MyMemory（免费兜底）─────────────────────────── */

const mymemory: Provider = {
  id: 'mymemory',
  label: 'MyMemory（免费兜底）',
  needsKey: false,
  hint: '无需配置。匿名每天 5000 字符，质量一般，仅作兜底',
  batchSize: 0,
  available: () => true,
  async translate(texts, source, target, signal) {
    const one = async (text: string): Promise<string> => {
      // 接口对单条长度有硬限制，超长直接放弃而不是返回半截
      if (Buffer.byteLength(text) > 500) throw new TranslateError('mymemory', '单条文本超过 500 字节上限');
      const params = new URLSearchParams({ q: text, langpair: `${source === 'auto' ? 'ja' : source}|${target}` });
      if (TRANSLATE.myMemoryEmail) params.set('de', TRANSLATE.myMemoryEmail);
      const json = (await fetchJson(
        `https://api.mymemory.translated.net/get?${params}`,
        { signal },
        'mymemory',
      )) as { responseData?: { translatedText?: string }; responseStatus?: number | string };
      if (Number(json.responseStatus) !== 200) throw new TranslateError('mymemory', `响应状态 ${json.responseStatus}`);
      return json.responseData?.translatedText ?? '';
    };
    return Promise.all(texts.map(one));
  },
};

/* ─────────────────────────── LibreTranslate ─────────────────────────── */

const libre: Provider = {
  id: 'libre',
  label: 'LibreTranslate',
  needsKey: false,
  hint: '在 .env 设置 LIBRETRANSLATE_URL（可自建，完全离线）',
  batchSize: 20,
  available: () => Boolean(TRANSLATE.libreUrl),
  async translate(texts, source, target, signal) {
    const json = (await fetchJson(
      `${TRANSLATE.libreUrl}/translate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          q: texts,
          source: source === 'auto' ? 'auto' : source,
          target: LIBRE_LANG[target] ?? 'zh',
          format: 'text',
          api_key: TRANSLATE.libreKey || undefined,
        }),
        signal,
      },
      'libre',
    )) as { translatedText?: string | string[] };
    const out = json.translatedText;
    if (Array.isArray(out)) return texts.map((_, i) => out[i] ?? '');
    return texts.map((_, i) => (i === 0 ? (out ?? '') : ''));
  },
};

/* ─────────────────────────── AI（复用已配置的大模型）─────────────────────────── */

const ai: Provider = {
  id: 'ai',
  label: `AI 翻译（${AI.model}）`,
  needsKey: true,
  hint: '复用 .env 里的 AI_API_KEY。上下文理解最好，适合文学性文本，但速度较慢',
  batchSize: 20,
  available: () => AI.configured,
  async translate(texts, _source, target, signal) {
    const lang = LANG_LABEL[target] ?? target;
    const numbered = texts.map((t, i) => `${i + 1}. ${t.replace(/\n/g, ' ')}`).join('\n');
    const res = await fetch(`${AI.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${AI.apiKey}` },
      body: JSON.stringify({
        model: AI.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              `你是专业的日语译者。把用户给出的每一条日语句子翻译成${lang}。` +
              `要求：忠实、通顺、保留原文语气与文体（敬体/简体、书面/口语）；不要添加解释；不要合并或拆分条目。` +
              `只输出 JSON：{"translations":["第1条译文","第2条译文",...]}，数组长度必须与输入条数一致。`,
          },
          { role: 'user', content: numbered },
        ],
      }),
      signal,
    });
    if (!res.ok) {
      throw new TranslateError('ai', `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content ?? '';
    let list: unknown;
    try {
      list = (JSON.parse(content) as { translations?: unknown }).translations;
    } catch {
      throw new TranslateError('ai', '模型未返回合法 JSON');
    }
    if (!Array.isArray(list)) throw new TranslateError('ai', '模型返回的 translations 不是数组');
    return texts.map((_, i) => (typeof list[i] === 'string' ? (list[i] as string) : ''));
  },
};

/* ─────────────────────────── 注册表 ─────────────────────────── */

/** 顺序即自动选择时的优先级 */
export const PROVIDERS: Provider[] = [deepl, microsoft, ai, google, libre, mymemory];

export function getProvider(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** 解析实际生效的 provider：环境变量指定优先，否则取第一个可用的 */
export function resolveProvider(preferred?: string): Provider {
  const wanted = preferred || TRANSLATE.provider;
  if (wanted && wanted !== 'auto') {
    const p = getProvider(wanted);
    if (p?.available()) return p;
  }
  return PROVIDERS.find((p) => p.available()) ?? google;
}

/** 主 provider 失败后的候选链 */
export function fallbackChain(active: Provider): Provider[] {
  return PROVIDERS.filter((p) => p.id !== active.id && p.available() && !p.needsKey);
}
