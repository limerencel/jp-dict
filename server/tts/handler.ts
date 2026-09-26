import type http from 'node:http';
import { PronunciationError } from './errors.ts';
import { preparePronunciation } from './input.ts';
import { VOICE } from './provider.ts';
import type { PronunciationStore } from './store.ts';

export interface HandlerOptions {
  enabled: boolean;
  store: PronunciationStore;
  allowedOrigin?: string;
}

const MAX_TTS_BODY = 4096;

function sendJsonError(res: http.ServerResponse, status: number, error: string): void {
  const buf = Buffer.from(JSON.stringify({ error }));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(buf.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(buf);
}

function isOriginAllowed(origin: string | undefined, allowedOrigin: string): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const a = new URL(allowedOrigin);
    if (u.origin === a.origin) return true;
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
  } catch {
    return false;
  }
  return false;
}

export function createPronunciationHandler(options: HandlerOptions) {
  const allowedOrigin = options.allowedOrigin || 'https://jp.itsuhiro.com';

  return async function handlePronunciation(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      sendJsonError(res, 405, '方法不允许，仅支持 POST');
      return;
    }

    const secFetchSite = req.headers['sec-fetch-site'];
    if (typeof secFetchSite === 'string' && secFetchSite.toLowerCase() === 'cross-site') {
      sendJsonError(res, 403, '禁止跨站发音请求');
      return;
    }

    const origin = req.headers.origin;
    if (typeof origin === 'string' && !isOriginAllowed(origin, allowedOrigin)) {
      sendJsonError(res, 403, '禁止未经授权的来源请求');
      return;
    }

    if (!options.enabled) {
      sendJsonError(res, 503, '发音服务暂未启用');
      return;
    }

    let rawBody = '';
    let size = 0;
    try {
      for await (const chunk of req) {
        const buf = chunk as Buffer;
        size += buf.length;
        if (size > MAX_TTS_BODY) {
          throw new PronunciationError(400, '请求体过大，发音单词或短语不能超过 4KB');
        }
        rawBody += buf.toString('utf8');
      }
    } catch (err) {
      if (err instanceof PronunciationError) {
        sendJsonError(res, err.status, err.message);
        return;
      }
      sendJsonError(res, 400, '读取请求体失败');
      return;
    }

    let parsed: unknown;
    try {
      parsed = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      sendJsonError(res, 400, '请求体不是合法的 JSON');
      return;
    }

    try {
      const item = preparePronunciation(parsed);
      const ctrl = new AbortController();
      req.on('close', () => {
        if (!res.writableEnded) ctrl.abort();
      });

      const { audio, hit } = await options.store.getOrCreate(item, ctrl.signal);

      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-length': String(audio.length),
        'cache-control': 'private, max-age=86400',
        'x-content-type-options': 'nosniff',
        'x-pronunciation-voice': VOICE,
        'x-pronunciation-cache': hit ? 'HIT' : 'MISS',
      });
      res.end(audio);
    } catch (err) {
      if (err instanceof PronunciationError) {
        sendJsonError(res, err.status, err.message);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error('[tts] 发音失败:', err);
      sendJsonError(res, 500, `发音服务异常: ${message}`);
    }
  };
}
