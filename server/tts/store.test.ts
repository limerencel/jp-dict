import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fixtureMp3 } from './fixtures.ts';
import { PronunciationStore } from './store.ts';

test('store caches audio on disk and deduplicates concurrent synthesis', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-tts-store-test-'));
  try {
    let synthCalls = 0;
    const synth = async (ssml: string) => {
      synthCalls++;
      await new Promise((r) => setTimeout(r, 15));
      return fixtureMp3();
    };

    const store = new PronunciationStore({
      cacheDir: tmpDir,
      dailyCharLimit: 1000,
      monthlyCharLimit: 5000,
      synthesizer: synth,
    });

    const req = {
      surface: '学校',
      reading: 'がっこう',
      ssml: '<speak><phoneme alphabet="yomigana" ph="^がっこう">学校</phoneme></speak>',
      characters: 70,
    };

    // 并发两个相同请求 -> singleflight
    const [res1, res2] = await Promise.all([
      store.getOrCreate(req, new AbortController().signal),
      store.getOrCreate(req, new AbortController().signal),
    ]);

    assert.equal(synthCalls, 1, 'concurrent requests should share a single synth call');
    assert.equal(res1.hit, false);
    assert.equal(res2.hit, false);
    assert.deepEqual(res1.audio, fixtureMp3());
    assert.deepEqual(res2.audio, fixtureMp3());

    // 再次请求 -> 命中缓存
    const res3 = await store.getOrCreate(req, new AbortController().signal);
    assert.equal(synthCalls, 1, 'cached request should not invoke synth');
    assert.equal(res3.hit, true);
    assert.deepEqual(res3.audio, fixtureMp3());

    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('store enforces daily and monthly character limits and persists across restarts', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-tts-store-quota-'));
  try {
    let synthCalls = 0;
    const synth = async () => {
      synthCalls++;
      return fixtureMp3();
    };

    // 限制每日配额 100 字符
    const store1 = new PronunciationStore({
      cacheDir: tmpDir,
      dailyCharLimit: 100,
      monthlyCharLimit: 1000,
      synthesizer: synth,
    });

    const req1 = {
      surface: '食べる',
      reading: 'たべる',
      ssml: '<speak>食べる1</speak>',
      characters: 60,
    };

    await store1.getOrCreate(req1, new AbortController().signal);
    assert.equal(synthCalls, 1);
    store1.close();

    // 重启 Store
    const store2 = new PronunciationStore({
      cacheDir: tmpDir,
      dailyCharLimit: 100,
      monthlyCharLimit: 1000,
      synthesizer: synth,
    });

    const req2 = {
      surface: '飲む',
      reading: 'のむ',
      ssml: '<speak>飲む2</speak>',
      characters: 60, // 60 + 60 = 120 > 100
    };

    await assert.rejects(
      () => store2.getOrCreate(req2, new AbortController().signal),
      (err: any) => err.status === 429 && /配额|quota|limit/i.test(err.message),
    );

    assert.equal(synthCalls, 1, 'exceeded quota should not invoke synth');
    store2.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
