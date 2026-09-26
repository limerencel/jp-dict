import assert from 'node:assert/strict';
import test from 'node:test';

import { fixtureMp3 } from './fixtures.ts';
import * as provider from './provider.ts';

test('provider requests exact Achernar SSML payload and dedicated auth scope', async () => {
  const calls: any[] = [];
  const synth = provider.createGoogleSynthesizer({ keyFilename: '/fixture/dedicated.json', projectId: 'bound-to-hk-payment' }, {
    createAuth: (options: unknown) => {
      calls.push(options);
      return { getAccessToken: async () => 'fixture-token-not-a-secret' };
    },
    fetch: async (url, init) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ audioContent: fixtureMp3().toString('base64') }));
    },
  });
  const audio = await synth('<speak>fixture</speak>', new AbortController().signal);
  assert.deepEqual(audio, fixtureMp3());
  assert.deepEqual(calls[0], {
    keyFilename: '/fixture/dedicated.json', projectId: 'bound-to-hk-payment',
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    clientOptions: { transporterOptions: { timeout: 10000, retry: false } },
  });
  assert.equal(calls[1][0], 'https://texttospeech.googleapis.com/v1/text:synthesize');
  const init = calls[1][1];
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, 'Bearer fixture-token-not-a-secret');
  assert.equal(init.headers['x-goog-user-project'], 'bound-to-hk-payment');
  assert.deepEqual(JSON.parse(init.body), {
    input: { ssml: '<speak>fixture</speak>' },
    voice: { languageCode: 'ja-JP', name: 'ja-JP-Chirp3-HD-Achernar' },
    audioConfig: { audioEncoding: 'MP3', speakingRate: 1 },
  });
});
