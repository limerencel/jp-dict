/**
 * 词典模块的软依赖桥接层。
 *
 * `server/dict/index.ts` 由另一条线并行开发，可能尚不存在或运行时抛错。
 * 这里统一做惰性动态 import + 全量 try/catch，任何失败都降级为「查不到」，
 * 使形态分析、助词判定、活用还原在没有词典的情况下依然完整可用。
 */
import type { DictEntry, DictionaryMeta, FrequencyInfo, PitchAccent } from '../../shared/types.ts';

export interface DictQuery {
  term: string;
  reading?: string;
}

interface DictModule {
  isReady?: () => boolean;
  listDictionaries?: () => DictionaryMeta[];
  lookupTermsBatch?: (queries: DictQuery[], limitPerQuery?: number) => Map<string, DictEntry[]>;
  lookupTerm?: (term: string, reading?: string, limit?: number) => DictEntry[];
  lookupPitch?: (term: string, reading?: string) => PitchAccent[];
  lookupFrequency?: (term: string, reading?: string) => FrequencyInfo[];
}

/** lookupTermsBatch 约定的 Map key */
export function queryKey(term: string, reading?: string): string {
  return `${term}\u0000${reading ?? ''}`;
}

let loaded: DictModule | null = null;
let loading: Promise<DictModule | null> | null = null;
let lastError: string | null = null;

/** 用变量作为 specifier，避免 tsc 在 dict 模块尚不存在时报解析错误 */
const DICT_SPECIFIER = '../dict/index.ts';

async function loadDict(): Promise<DictModule | null> {
  if (loaded) return loaded;
  if (loading) return loading;
  loading = (async () => {
    try {
      const mod = (await import(DICT_SPECIFIER)) as DictModule;
      loaded = mod;
      lastError = null;
      return mod;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  })();
  return loading;
}

/** 预加载词典模块；返回是否可用 */
export async function initDict(): Promise<boolean> {
  const mod = await loadDict();
  if (!mod) return false;
  try {
    return mod.isReady ? mod.isReady() : true;
  } catch {
    return false;
  }
}

export function dictError(): string | null {
  return lastError;
}

export async function dictReady(): Promise<boolean> {
  const mod = await loadDict();
  if (!mod?.isReady) return Boolean(mod?.lookupTerm || mod?.lookupTermsBatch);
  try {
    return mod.isReady();
  } catch {
    return false;
  }
}

export async function listDictionaries(): Promise<DictionaryMeta[]> {
  const mod = await loadDict();
  try {
    return mod?.listDictionaries?.() ?? [];
  } catch {
    return [];
  }
}

/**
 * 批量查词。词典不可用时返回空 Map，调用方按「未命中」处理。
 * 内部会去重，调用方不必自行去重。
 */
export async function lookupTermsBatch(queries: DictQuery[], limitPerQuery = 8): Promise<Map<string, DictEntry[]>> {
  const empty = new Map<string, DictEntry[]>();
  if (queries.length === 0) return empty;
  const mod = await loadDict();
  if (!mod) return empty;

  const seen = new Set<string>();
  const unique: DictQuery[] = [];
  for (const q of queries) {
    if (!q.term) continue;
    const key = queryKey(q.term, q.reading);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(q);
  }

  try {
    if (mod.lookupTermsBatch) {
      const res = mod.lookupTermsBatch(unique, limitPerQuery);
      return res instanceof Map ? res : empty;
    }
    if (mod.lookupTerm) {
      const res = new Map<string, DictEntry[]>();
      for (const q of unique) {
        const entries = mod.lookupTerm(q.term, q.reading, limitPerQuery) ?? [];
        if (entries.length > 0) res.set(queryKey(q.term, q.reading), entries);
      }
      return res;
    }
  } catch {
    return empty;
  }
  return empty;
}

export async function lookupPitch(term: string, reading?: string): Promise<PitchAccent[]> {
  const mod = await loadDict();
  try {
    return mod?.lookupPitch?.(term, reading) ?? [];
  } catch {
    return [];
  }
}

export async function lookupFrequency(term: string, reading?: string): Promise<FrequencyInfo[]> {
  const mod = await loadDict();
  try {
    return mod?.lookupFrequency?.(term, reading) ?? [];
  } catch {
    return [];
  }
}

/** 批量取声调/频率；词典不可用时全部为空 */
export async function lookupExtras(
  queries: DictQuery[],
): Promise<{ pitch: Map<string, PitchAccent[]>; frequency: Map<string, FrequencyInfo[]> }> {
  const pitch = new Map<string, PitchAccent[]>();
  const frequency = new Map<string, FrequencyInfo[]>();
  const mod = await loadDict();
  if (!mod || (!mod.lookupPitch && !mod.lookupFrequency)) return { pitch, frequency };

  const seen = new Set<string>();
  for (const q of queries) {
    if (!q.term) continue;
    const key = queryKey(q.term, q.reading);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const p = mod.lookupPitch?.(q.term, q.reading);
      if (p && p.length > 0) pitch.set(key, p);
    } catch {
      /* 忽略单条失败 */
    }
    try {
      const f = mod.lookupFrequency?.(q.term, q.reading);
      if (f && f.length > 0) frequency.set(key, f);
    } catch {
      /* 忽略单条失败 */
    }
  }
  return { pitch, frequency };
}
