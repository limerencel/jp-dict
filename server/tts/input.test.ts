import assert from 'node:assert/strict';
import test from 'node:test';

import { preparePronunciation } from './input.ts';

test('normalizes half-width kana and leaves unspecified accent unspecified', () => {
  const result = preparePronunciation({ surface: '学校', reading: 'ｶﾞｯｺｳ' });
  assert.equal(result?.reading, 'がっこう');
  assert.equal(result?.ssml, '<speak><phoneme alphabet="yomigana" ph="がっこう">学校</phoneme></speak>');
  assert.equal(result?.characters, [...result!.ssml].length);
});

test('explicit accent uses mora boundaries, including small kana, っ, ん and ー', () => {
  for (const [reading, pitch, phoneme] of [
    ['キャット', 0, '^きゃっと'], ['キャット', 1, '^きゃ!っと'],
    ['キャット', 2, '^きゃっ!と'], ['ギャングー', 4, '^ぎゃんぐー!'],
  ] as const) {
    assert.match(preparePronunciation({ surface: reading, reading, pitch }).ssml, new RegExp(`ph="${phoneme.replace('^', '\\^')}"`));
  }
});

test('XML text is escaped, never interpreted as SSML', () => {
  const { ssml } = preparePronunciation({ surface: '<雨 & "雪"\'>', reading: 'あめ' });
  assert.equal(ssml, '<speak><phoneme alphabet="yomigana" ph="あめ">&lt;雨 &amp; &quot;雪&quot;&apos;&gt;</phoneme></speak>');
});

test('rejects malformed or unsafe inputs with a safe 400 error', () => {
  const bad: unknown[] = [null, [], '', {}, { surface: '学校' }, { surface: '学校', reading: '' },
    { surface: '学校', reading: 1 }, { surface: '学\u0000校', reading: 'がっこう' },
    { surface: '学\u200b校', reading: 'がっこう' }, { surface: '\ud800', reading: 'あ' },
    { surface: ' ', reading: 'あ' }, { surface: 'あ'.repeat(81), reading: 'あ' },
    ...['が こう', 'が\nこう', '漢字', '^あ', 'あ!', '<speak>', 'abc', 'あ'.repeat(81)].map(reading => ({ surface: '学校', reading })),
    ...[-1, 5, 0.5, '1', null, NaN, Infinity].map(pitch => ({ surface: '学校', reading: 'がっこう', pitch })),
    { surface: '学校', reading: 'がっこう', voice: 'other' },
    { surface: '学校', reading: 'がっこう', endpoint: 'https://evil.invalid' },
  ];
  for (const value of bad) {
    assert.throws(() => preparePronunciation(value), (error: any) => error.status === 400 && !error.message.includes('evil.invalid'));
  }
});

test('only pure kana may supply its own missing reading; lengths count code points', () => {
  assert.equal(preparePronunciation({ surface: 'ｷｬｯﾄ' }).reading, 'きゃっと');
  assert.equal(preparePronunciation({ surface: 'カタカナ', reading: '' }).reading, 'かたかな');
  assert.equal(preparePronunciation({ surface: '𠮷'.repeat(80), reading: 'あ'.repeat(80) }).surface.length, 160);
});
