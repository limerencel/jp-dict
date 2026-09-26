/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from '../api.ts';

test('rejects provider errors, non-audio and empty responses while preserving aborts', async () => {
  const req = { surface: '橋', reading: 'はし' };
  await assert.rejects(api.pronunciation(req, undefined, async () => new Response(
    JSON.stringify({ error: '发音服务暂不可用' }), { status: 503 },
  )), (err: unknown) => err instanceof api.ApiError && err.status === 503 && err.message === '发音服务暂不可用');
  for (const response of [
    new Response('<html>proxy</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('', { headers: { 'Content-Type': 'audio/mpeg' } }),
  ]) {
    await assert.rejects(api.pronunciation(req, undefined, async () => response), /音频/);
  }
  await assert.rejects(api.pronunciation(req, undefined, async () => { throw new TypeError('private URL'); }),
    (err: unknown) => err instanceof api.ApiError && err.offline && !err.message.includes('private'));
  const aborted = new DOMException('Cancelled', 'AbortError');
  await assert.rejects(api.pronunciation(req, undefined, async () => { throw aborted; }), (err: unknown) => err === aborted);
});

test('POSTs the exact selected surface/reading/pitch to the fixed-voice backend and returns MP3 bytes', async () => {
  assert.equal(typeof api.pronunciation, 'function', 'pronunciation API is implemented');
  const request = { surface: '箸', reading: 'はし', pitch: 1 };
  const abort = new AbortController();
  let calls = 0;
  const blob = await api.pronunciation(request, abort.signal, async (url, init) => {
    calls++;
    assert.equal(url, '/api/pronunciation');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json');
    assert.equal(new Headers(init?.headers).get('Accept'), 'audio/mpeg');
    assert.equal(init?.signal, abort.signal);
    assert.deepEqual(JSON.parse(String(init?.body)), request);
    return new Response(new Uint8Array([73, 68, 51]), { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  assert.equal(calls, 1);
  assert.equal(blob.type, 'audio/mpeg');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [73, 68, 51]);
});
