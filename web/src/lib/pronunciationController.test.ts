/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPronunciationController, type PronunciationAudio } from './pronunciationController.ts';
import type { PronunciationRequest } from './pronunciation.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class FakeAudio extends EventTarget implements PronunciationAudio {
  src = '';
  currentTime = 0;
  plays = 0;
  pauses = 0;
  loads = 0;
  playResult: () => Promise<void> = () => Promise.resolve();
  play() {
    this.plays++;
    return this.playResult();
  }
  pause() {
    this.pauses++;
  }
  load() {
    this.loads++;
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
}

const A = { surface: '生', reading: 'なま' };
const B = { surface: '生', reading: 'せい' };
const mp3 = () => new Blob(['test-only MP3 fixture'], { type: 'audio/mpeg' });

function harness(options: { defaultPlayResult?: () => Promise<void> } = {}) {
  const requests: {
    target: PronunciationRequest;
    signal: AbortSignal;
    result: ReturnType<typeof deferred<Blob>>;
  }[] = [];
  const audios: FakeAudio[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  const controller = createPronunciationController({
    request: (target, signal) => {
      const result = deferred<Blob>();
      requests.push({ target, signal, result });
      return result.promise;
    },
    createAudio: () => {
      const audio = new FakeAudio();
      if (options.defaultPlayResult) audio.playResult = options.defaultPlayResult;
      audios.push(audio);
      return audio;
    },
    createObjectURL: () => {
      const url = `blob:fixture-${created.length}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url) => {
      revoked.push(url);
    },
  });
  return { controller, requests, audios, created, revoked };
}

test('is inert before a click, requests the exact target, plays and replays the retained blob', async () => {
  const h = harness();
  assert.equal(h.requests.length, 0);
  assert.equal(h.audios.length, 0);
  assert.equal(h.controller.getSnapshot().status, 'idle');
  const pending = h.controller.activate('head', A);
  assert.deepEqual(h.requests[0].target, A);
  assert.equal(h.controller.getSnapshot().status, 'loading');
  h.requests[0].result.resolve(mp3());
  await pending;
  assert.equal(h.controller.getSnapshot().status, 'playing');
  assert.equal(h.audios[0].plays, 1);
  assert.equal(h.audios[0].src, h.created[0]);
  h.audios[0].dispatchEvent(new Event('ended'));
  assert.equal(h.controller.getSnapshot().status, 'ready');
  h.audios[0].currentTime = 3;
  await h.controller.activate('head', A);
  assert.equal(h.requests.length, 1, 'replay must not synthesize again');
  assert.equal(h.audios[0].plays, 2);
  assert.equal(h.audios[0].currentTime, 0);
});

test('switching target cancels previous pending request and revokes previous URL', async () => {
  const h = harness();
  h.controller.activate('first', A);
  assert.equal(h.requests[0].signal.aborted, false);

  const pendingB = h.controller.activate('second', B);
  assert.equal(h.requests[0].signal.aborted, true, 'previous request should be aborted');
  assert.equal(h.controller.getSnapshot().status, 'loading');
  assert.equal(h.controller.getSnapshot().id, 'second');

  h.requests[1].result.resolve(mp3());
  await pendingB;
  assert.equal(h.controller.getSnapshot().status, 'playing');
  assert.equal(h.audios[0].src, h.created[0]);
});

test('handles NotAllowedError gracefully by keeping state ready for user gesture replay', async () => {
  const notAllowed = new Error('play rejected');
  notAllowed.name = 'NotAllowedError';
  const h = harness({ defaultPlayResult: () => Promise.reject(notAllowed) });

  const pending = h.controller.activate('head', A);
  h.requests[0].result.resolve(mp3());
  await pending;

  const snap = h.controller.getSnapshot();
  assert.equal(snap.status, 'ready');
  assert.match(snap.error ?? '', /点击播放/);
});

test('handles request errors properly', async () => {
  const h = harness();
  const pending = h.controller.activate('head', A);
  h.requests[0].result.reject(new Error('Network offline'));
  await pending;

  const snap = h.controller.getSnapshot();
  assert.equal(snap.status, 'error');
  assert.equal(snap.error, 'Network offline');
});
