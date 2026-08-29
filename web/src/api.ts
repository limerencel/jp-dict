/**
 * 所有后端调用的唯一出口：fetch 封装、错误归一化、SSE 解析。
 */
import type {
  AnalysisResult,
  ChatRequest,
  DictionaryMeta,
  LookupRequest,
  LookupResponse,
  TranslateConfig,
  TranslateRequest,
  TranslateResponse,
} from '@shared/types';

export interface AppConfig {
  aiConfigured: boolean;
  aiModel: string;
  maxTextLength: number;
  dictDir: string;
  dictReady: boolean;
  translate: TranslateConfig;
}

/** 服务端一次最多接受的待译条数 */
export const TRANSLATE_MAX_BATCH = 200;

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

export function translate(req: TranslateRequest, signal?: AbortSignal): Promise<TranslateResponse> {
  return postJson<TranslateResponse>('/api/translate', req, signal);
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

/* ────────────────────────────── SSE 聊天 ────────────────────────────── */

interface ChatEvent {
  type?: string;
  text?: string;
  message?: string;
}

export interface ChatStreamHandlers {
  onDelta: (text: string) => void;
  /** 服务端在流中报告的错误（非致命，流可能仍会 DONE） */
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

/**
 * POST + SSE：EventSource 只支持 GET，这里手动解析 text/event-stream。
 * 只识别 `data:` 行，`[DONE]` 结束。
 */
export async function streamChat(req: ChatRequest, handlers: ChatStreamHandlers): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(req),
      signal: handlers.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    throw new ApiError('无法连接到服务器', 0, err instanceof Error ? err.message : undefined);
  }

  if (!res.ok) throw await readError(res);
  if (!res.body) throw new ApiError('服务器未返回流式响应', res.status);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;

  const handleLine = (rawLine: string): void => {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.startsWith(':')) return;
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      done = true;
      return;
    }
    let evt: ChatEvent;
    try {
      evt = JSON.parse(payload) as ChatEvent;
    } catch {
      return; // 忽略无法解析的片段，不要中断整条流
    }
    if (evt.type === 'delta' && typeof evt.text === 'string') handlers.onDelta(evt.text);
    else if (evt.type === 'error') handlers.onError?.(evt.message || '模型返回错误');
  };

  try {
    while (!done) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (done) break;
      }
    }
    if (!done && buffer) handleLine(buffer);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    throw err;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 已关闭 */
    }
  }
}
