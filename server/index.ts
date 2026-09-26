import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DICT_DIR, HOST, MAX_TEXT_LENGTH, PORT, ROOT, ensureDirs } from './config.ts';
import { analyze, warmup } from './analyze/index.ts';
import {
  closeDictionaries,
  deleteDictionary,
  initDictionaries,
  isReady,
  listDictionaries,
  lookupFrequency,
  lookupKanji,
  lookupPitch,
  getDictionaryStyle,
  lookupTerm,
  resolveMediaPath,
  scanAndImport,
  setDictionaryEnabled,
  setDictionaryPriority,
} from './dict/index.ts';
import { isKanji } from '../shared/kana.ts';
import type { DictEntry, LookupResponse } from '../shared/types.ts';
import { closePronunciation, handlePronunciation } from './tts/index.ts';

const WEB_DIST = path.join(ROOT, 'dist', 'web');

/* ────────────────────────── HTTP 小工具 ────────────────────────── */

type Res = http.ServerResponse;

function sendJson(res: Res, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
  });
  res.end(buf);
}

function sendError(res: Res, status: number, error: string, detail?: string): void {
  sendJson(res, status, detail ? { error, detail } : { error });
}

const MAX_BODY = 8 * 1024 * 1024;

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('请求体过大');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function sendFile(res: Res, filePath: string, immutable = false): void {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      sendError(res, 404, '未找到');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ────────────────────────── 业务处理 ────────────────────────── */

function entryKey(e: DictEntry): string {
  return `${e.dictId}\u0000${e.term}\u0000${e.reading}\u0000${e.sequence}`;
}

/**
 * 按相关度重排词条。
 *
 * 很多词典（如研究社）所有条目的 score 都是 0，此时库里的顺序就是字典序，
 * 会出现查「いい」时生僻名词「謂」排在形容词「良い」前面这种情况。
 * 释义体量是此时最可靠的常用度代理指标，作为最后一道兑底。
 */
function rankEntries(entries: DictEntry[], query: string, reading: string): DictEntry[] {
  const weight = (e: DictEntry): number[] => [
    -e.dictPriority,
    e.term === query ? 0 : 1,
    reading && e.reading === reading ? 0 : 1,
    -e.score,
    -JSON.stringify(e.glossary).length,
    e.sequence,
  ];
  return entries
    .map((e) => ({ e, w: weight(e) }))
    .sort((a, b) => {
      for (let i = 0; i < a.w.length; i++) {
        if (a.w[i] !== b.w[i]) return a.w[i] - b.w[i];
      }
      return 0;
    })
    .map((x) => x.e);
}

function handleLookup(body: unknown): LookupResponse {
  const b = (body ?? {}) as { surface?: unknown; lemma?: unknown; reading?: unknown };
  const surface = typeof b.surface === 'string' ? b.surface.trim() : '';
  const lemma = typeof b.lemma === 'string' ? b.lemma.trim() : '';
  const reading = typeof b.reading === 'string' ? b.reading.trim() : '';
  const query = lemma || surface;
  if (!query) return { query: '', entries: [], kanji: [], pitch: [], frequency: [] };

  // 辞書形优先，其次表层形；先带读音消歧，若一无所获再放开读音限制
  const entries: DictEntry[] = [];
  const seen = new Set<string>();
  const push = (list: DictEntry[]) => {
    for (const e of list) {
      const k = entryKey(e);
      if (!seen.has(k)) {
        seen.add(k);
        entries.push(e);
      }
    }
  };

  const candidates = [lemma, surface].filter((t, i, a) => t && a.indexOf(t) === i);
  for (const term of candidates) push(lookupTerm(term, reading || undefined, 80));
  if (entries.length === 0 && reading) {
    for (const term of candidates) push(lookupTerm(term, undefined, 80));
  }
  if (entries.length === 0 && reading) push(lookupTerm(reading, undefined, 30));

  const chars = [...new Set([...query].filter(isKanji))];

  return {
    query,
    entries: rankEntries(entries, query, reading),
    kanji: chars.length ? lookupKanji(chars) : [],
    pitch: lookupPitch(query, reading || undefined),
    frequency: lookupFrequency(query, reading || undefined),
  };
}

/* ────────────────────────── 路由 ────────────────────────── */

async function route(req: http.IncomingMessage, res: Res): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method || 'GET';

  if (!pathname.startsWith('/api/')) {
    // 生产模式下托管构建产物；开发模式由 Vite 提供页面
    if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, '方法不允许');
    if (!fs.existsSync(WEB_DIST)) {
      return sendError(res, 404, '前端尚未构建', '开发时请访问 Vite 的 http://localhost:5173，或先运行 npm run build');
    }
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const target = path.join(WEB_DIST, rel);
    if (!target.startsWith(WEB_DIST)) return sendError(res, 403, '非法路径');
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
      return sendFile(res, target, rel.startsWith('assets/'));
    }
    return sendFile(res, path.join(WEB_DIST, 'index.html'));
  }

  /* ---- 配置 ---- */
  if (pathname === '/api/config' && method === 'GET') {
    return sendJson(res, 200, {
      maxTextLength: MAX_TEXT_LENGTH,
      dictDir: DICT_DIR,
      dictReady: isReady(),
    });
  }

  /* ---- 分析 ---- */
  if (pathname === '/api/analyze' && method === 'POST') {
    const body = (await readJsonBody(req)) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) return sendError(res, 400, '请输入要分析的日语文本');
    return sendJson(res, 200, await analyze(text));
  }

  /* ---- 查词 ---- */
  if (pathname === '/api/lookup' && method === 'POST') {
    return sendJson(res, 200, handleLookup(await readJsonBody(req)));
  }

  /* ---- 发音 ---- */
  if (pathname === '/api/pronunciation') {
    return void (await handlePronunciation(req, res));
  }

  /* ---- 词典管理 ---- */
  if (pathname === '/api/dictionaries' && method === 'GET') {
    return sendJson(res, 200, { dictionaries: listDictionaries(), ready: isReady(), dictDir: DICT_DIR });
  }

  if (pathname === '/api/dictionaries/rescan' && method === 'POST') {
    return sendJson(res, 200, await scanAndImport());
  }

  /* ---- MDict 词典自带的样式表（已作用域化到 .mdx-dict-<id>）---- */
  const styleMatch = /^\/api\/dictionaries\/(\d+)\/style\.css$/.exec(pathname);
  if (styleMatch && (method === 'GET' || method === 'HEAD')) {
    const css = getDictionaryStyle(Number(styleMatch[1]));
    if (css == null) return sendError(res, 404, '该词典没有自带样式');
    const body = Buffer.from(css, 'utf8');
    res.writeHead(200, {
      'content-type': 'text/css; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    return void res.end(body);
  }

  const dictMatch = /^\/api\/dictionaries\/(\d+)$/.exec(pathname);
  if (dictMatch) {
    const id = Number(dictMatch[1]);
    if (method === 'PATCH') {
      const body = (await readJsonBody(req)) as { enabled?: unknown; priority?: unknown };
      let meta = null;
      if (typeof body.enabled === 'boolean') meta = setDictionaryEnabled(id, body.enabled);
      if (typeof body.priority === 'number' && Number.isFinite(body.priority)) {
        meta = setDictionaryPriority(id, Math.trunc(body.priority));
      }
      if (!meta) return sendError(res, 404, '词典不存在或没有可更新的字段');
      return sendJson(res, 200, meta);
    }
    if (method === 'DELETE') {
      return deleteDictionary(id) ? sendJson(res, 200, { ok: true }) : sendError(res, 404, '词典不存在');
    }
    return sendError(res, 405, '方法不允许');
  }

  /* ---- 词典内嵌媒体 ---- */
  const mediaMatch = /^\/api\/media\/(\d+)\/(.+)$/.exec(pathname);
  if (mediaMatch && (method === 'GET' || method === 'HEAD')) {
    const file = resolveMediaPath(Number(mediaMatch[1]), mediaMatch[2]);
    if (!file) return sendError(res, 404, '未找到媒体文件');
    return sendFile(res, file, true);
  }

  sendError(res, 404, `未知接口 ${method} ${pathname}`);
}

/* ────────────────────────── 启动 ────────────────────────── */

const server = http.createServer((req, res) => {
  route(req, res).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api] ${req.method} ${req.url} 失败:`, err);
    if (!res.headersSent) sendError(res, 500, '服务器内部错误', message);
    else if (!res.writableEnded) res.end();
  });
});

async function main(): Promise<void> {
  ensureDirs();

  server.listen(PORT, HOST, () => {
    console.log(`\n  日语语法解析服务  http://${HOST}:${PORT}`);
    console.log(`  开发前端         http://localhost:5173`);
    console.log(`  词典目录         ${DICT_DIR}`);
    console.log('');
  });

  // 分词器与词典在后台加载，不阻塞端口监听
  void warmup().then(
    () => console.log('  [分词] kuromoji 就绪'),
    (err: unknown) => console.error('  [分词] 加载失败:', err),
  );

  try {
    const dicts = await initDictionaries((p) => {
      if (p.phase === 'parse' || p.phase === 'write') return; // 过于频繁
      console.log(`  [词典] ${p.file}: ${p.message}`);
    });
    if (dicts.length === 0) {
      console.log(`  [词典] 尚未导入任何词典。把 Yomitan zip 或 MDict mdx 放入 ${DICT_DIR} 后重启，或在界面里点「重新扫描」。`);
    } else {
      console.log(`  [词典] 已就绪 ${dicts.length} 部：${dicts.map((d) => d.title).join('、')}`);
      await analyze('日本語の文法を解析するテスト。');
      console.log('  [预热] 语法与词典索引预热完成');
    }
  } catch (err) {
    console.error('  [词典] 初始化失败:', err);
  }
}

function shutdown(): void {
  server.close();
  try {
    closeDictionaries();
  } catch {
    /* 忽略关闭期异常 */
  }
  try {
    closePronunciation();
  } catch {
    /* 忽略关闭期异常 */
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

void main();
