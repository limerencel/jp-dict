import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { fixtureMp3 } from './fixtures.ts';
import { createPronunciationHandler } from './handler.ts';

function createMockReqRes(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) {
  const req = new http.IncomingMessage(null as any);
  req.method = options.method ?? 'POST';
  req.headers = {
    'content-type': 'application/json',
    ...(options.headers ?? {}),
  };

  const chunks = options.body ? [Buffer.from(options.body)] : [];
  req[Symbol.asyncIterator] = async function* () {
    for (const c of chunks) yield c;
  };

  let statusCode = 200;
  const headers: Record<string, string> = {};
  let bodyBuffer = Buffer.alloc(0);

  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(code: number) {
      statusCode = code;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    writeHead(code: number, hdrs?: Record<string, string>) {
      statusCode = code;
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          headers[k.toLowerCase()] = v;
        }
      }
      return this;
    },
    end(data?: Buffer | string) {
      if (data) {
        bodyBuffer = Buffer.isBuffer(data) ? (data as any) : Buffer.from(data);
      }
    },
    get headers() {
      return headers;
    },
    get body() {
      return bodyBuffer;
    },
    get json() {
      return JSON.parse(bodyBuffer.toString('utf8'));
    },
  } as unknown as http.ServerResponse & {
    headers: Record<string, string>;
    body: Buffer;
    json: any;
  };

  return { req, res };
}

test('handler rejects non-POST and cross-site requests', async () => {
  const handler = createPronunciationHandler({
    enabled: true,
    store: {
      getOrCreate: async () => ({ audio: fixtureMp3(), hit: false, hash: 'test' }),
    } as any,
    allowedOrigin: 'https://jp.itsuhiro.com',
  });

  // GET -> 405
  const { req: getReq, res: getRes } = createMockReqRes({ method: 'GET' });
  await handler(getReq, getRes);
  assert.equal(getRes.statusCode, 405);

  // Cross-site sec-fetch-site -> 403
  const { req: csReq, res: csRes } = createMockReqRes({
    headers: { 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ surface: '花', reading: 'はな' }),
  });
  await handler(csReq, csRes);
  assert.equal(csRes.statusCode, 403);

  // Untrusted origin -> 403
  const { req: originReq, res: originRes } = createMockReqRes({
    headers: { origin: 'https://malicious.com' },
    body: JSON.stringify({ surface: '花', reading: 'はな' }),
  });
  await handler(originReq, originRes);
  assert.equal(originRes.statusCode, 403);
});

test('handler synthesizes and returns audio/mpeg with metadata headers', async () => {
  const handler = createPronunciationHandler({
    enabled: true,
    store: {
      getOrCreate: async (item: any) => {
        assert.equal(item.surface, '学校');
        assert.equal(item.reading, 'がっこう');
        return { audio: fixtureMp3(), hit: false, hash: 'test-hash' };
      },
    } as any,
    allowedOrigin: 'https://jp.itsuhiro.com',
  });

  const { req, res } = createMockReqRes({
    headers: { origin: 'https://jp.itsuhiro.com' },
    body: JSON.stringify({ surface: '学校', reading: 'がっこう', pitch: 0 }),
  });

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'audio/mpeg');
  assert.equal(res.headers['x-pronunciation-voice'], 'ja-JP-Chirp3-HD-Achernar');
  assert.equal(res.headers['x-pronunciation-cache'], 'MISS');
  assert.deepEqual(res.body, fixtureMp3());
});

test('handler returns 503 when service is disabled', async () => {
  const handler = createPronunciationHandler({
    enabled: false,
    store: null as any,
    allowedOrigin: 'https://jp.itsuhiro.com',
  });

  const { req, res } = createMockReqRes({
    body: JSON.stringify({ surface: '学校', reading: 'がっこう' }),
  });

  await handler(req, res);
  assert.equal(res.statusCode, 503);
  assert.match(res.json.error, /未启用|disabled/i);
});
