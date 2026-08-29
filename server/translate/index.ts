/**
 * 翻译入口：缓存 → 分批 → 并发 → 失败自动降级到备用服务商。
 */
import { TRANSLATE } from '../config.ts';
import { LANG_LABEL, PROVIDERS, fallbackChain, resolveProvider, type Provider } from './providers.ts';

export interface TranslateResult {
  provider: string;
  providerLabel: string;
  target: string;
  translations: string[];
  /** 逐条标记是否命中缓存 */
  cached: boolean[];
  /** 主服务商失败后降级时给出的说明 */
  notice?: string;
}

export interface ProviderInfo {
  id: string;
  label: string;
  available: boolean;
  needsKey: boolean;
  hint: string;
}

/* ─────────────────────────── LRU 缓存 ─────────────────────────── */

const MAX_CACHE = 5000;
const cache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  // 命中后挪到队尾，实现 LRU
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: string): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export function clearTranslationCache(): void {
  cache.clear();
}

/* ─────────────────────────── 并发控制 ─────────────────────────── */

const CONCURRENCY = 4;

async function runBatches(
  provider: Provider,
  texts: string[],
  source: string,
  target: string,
  signal: AbortSignal,
): Promise<string[]> {
  // batchSize 为 0 的服务商不支持批量，退化成「每批 1 条 + 并发」
  const size = provider.batchSize > 0 ? provider.batchSize : 1;
  const batches: { start: number; items: string[] }[] = [];
  for (let i = 0; i < texts.length; i += size) {
    batches.push({ start: i, items: texts.slice(i, i + size) });
  }

  const out = new Array<string>(texts.length).fill('');
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, async () => {
    for (;;) {
      const index = cursor++;
      const batch = batches[index];
      if (!batch) return;
      const result = await provider.translate(batch.items, source, target, signal);
      for (let i = 0; i < batch.items.length; i++) out[batch.start + i] = result[i] ?? '';
    }
  });
  await Promise.all(workers);
  return out;
}

/* ─────────────────────────── 对外 API ─────────────────────────── */

export function listProviders(): ProviderInfo[] {
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    available: p.available(),
    needsKey: p.needsKey,
    hint: p.hint,
  }));
}

export function listTargets(): { code: string; label: string }[] {
  return Object.entries(LANG_LABEL).map(([code, label]) => ({ code, label }));
}

export function defaultTarget(): string {
  return TRANSLATE.target;
}

export function activeProviderId(): string {
  return resolveProvider().id;
}

export async function translate(
  texts: string[],
  options: { target?: string; source?: string; provider?: string } = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<TranslateResult> {
  const target = options.target || TRANSLATE.target;
  const source = options.source || 'ja';
  const primary = resolveProvider(options.provider);

  // 先吃缓存，只把未命中的送去翻译
  const cached = new Array<boolean>(texts.length).fill(false);
  const out = new Array<string>(texts.length).fill('');
  const pendingIndexes: number[] = [];
  const pendingTexts: string[] = [];

  texts.forEach((text, i) => {
    const trimmed = text.trim();
    if (!trimmed) {
      cached[i] = true;
      return;
    }
    const hit = cacheGet(`${primary.id}|${target}|${trimmed}`);
    if (hit !== undefined) {
      out[i] = hit;
      cached[i] = true;
    } else {
      pendingIndexes.push(i);
      pendingTexts.push(trimmed);
    }
  });

  if (pendingTexts.length === 0) {
    return { provider: primary.id, providerLabel: primary.label, target, translations: out, cached };
  }

  // 主服务商失败时，依次尝试无需密钥的备用服务商
  const chain: Provider[] = [primary, ...fallbackChain(primary)];
  const errors: string[] = [];
  for (const provider of chain) {
    try {
      const result = await runBatches(provider, pendingTexts, source, target, signal);
      pendingIndexes.forEach((originalIndex, i) => {
        const value = result[i] ?? '';
        out[originalIndex] = value;
        if (value) cacheSet(`${provider.id}|${target}|${pendingTexts[i]}`, value);
      });
      return {
        provider: provider.id,
        providerLabel: provider.label,
        target,
        translations: out,
        cached,
        notice:
          provider.id === primary.id
            ? undefined
            : `${primary.label}失败（${errors[0] ?? '未知原因'}），已自动改用${provider.label}`,
      };
    } catch (err) {
      if (signal.aborted) throw err;
      errors.push(`${provider.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`所有翻译服务均失败 —— ${errors.join('；')}`);
}
