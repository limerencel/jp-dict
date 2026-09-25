/**
 * 所有后端调用的唯一出口：fetch 封装与错误归一化。
 */
import type {
  AnalysisResult,
  DictionaryMeta,
  LookupRequest,
  LookupResponse,
} from '@shared/types';

export interface AppConfig {
  maxTextLength: number;
  dictDir: string;
  dictReady: boolean;
}

export interface DictionaryListResponse {
  dictionaries: DictionaryMeta[];
  ready: boolean;
  dictDir: string;
}

export interface RescanResponse {
  imported: DictionaryMeta[];
  skipped: string[];
  failed: { file: string; error: string }[];
}

/** 网络层与业务层错误统一成这一种类型，UI 只需处理一种分支 */
export class ApiError extends Error {
  readonly status: number;
  readonly detail?: string;

  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }

  /** status 为 0 表示压根没连上后端（后端未启动 / 代理失效） */
  get offline(): boolean {
    return this.status === 0;
  }
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.detail ? `${err.message}（${err.detail}）` : err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

async function readError(res: Response): Promise<ApiError> {
  let message = `请求失败（HTTP ${res.status}）`;
  let detail: string | undefined;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object') {
      const rec = body as Record<string, unknown>;
      if (typeof rec.error === 'string' && rec.error) message = rec.error;
      if (typeof rec.detail === 'string') detail = rec.detail;
    }
  } catch {
    /* 非 JSON 响应，保留默认文案 */
  }
  return new ApiError(message, res.status, detail);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('无法连接到服务器', 0, err instanceof Error ? err.message : undefined);
  }
  if (!res.ok) throw await readError(res);
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new ApiError('服务器返回了无法解析的内容', res.status, err instanceof Error ? err.message : undefined);
  }
}

function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

/* ────────────────────────────── 端点 ────────────────────────────── */

export function getConfig(signal?: AbortSignal): Promise<AppConfig> {
  return request<AppConfig>('/api/config', { signal });
}

export function analyze(text: string, signal?: AbortSignal): Promise<AnalysisResult> {
  return postJson<AnalysisResult>('/api/analyze', { text }, signal);
}

export function lookup(req: LookupRequest, signal?: AbortSignal): Promise<LookupResponse> {
  return postJson<LookupResponse>('/api/lookup', req, signal);
}

export function listDictionaries(signal?: AbortSignal): Promise<DictionaryListResponse> {
  return request<DictionaryListResponse>('/api/dictionaries', { signal });
}

export function rescanDictionaries(signal?: AbortSignal): Promise<RescanResponse> {
  return postJson<RescanResponse>('/api/dictionaries/rescan', {}, signal);
}

export function updateDictionary(
  id: number,
  patch: { enabled?: boolean; priority?: number },
): Promise<DictionaryMeta> {
  return request<DictionaryMeta>(`/api/dictionaries/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export function deleteDictionary(id: number): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/dictionaries/${id}`, { method: 'DELETE' });
}

/** 词典内嵌媒体资源地址 */
export function mediaUrl(dictId: number, path: string): string {
  const clean = String(path).replace(/^\/+/, '');
  return `/api/media/${dictId}/${encodeURI(clean)}`;
}
