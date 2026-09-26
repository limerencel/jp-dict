/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pronunciationTarget } from './pronunciation.ts';

test('sends pitch only for an unambiguous exact normalized reading with a valid mora position', () => {
  const input = { surface: '学校', reading: 'がっこう' };
  assert.equal(pronunciationTarget({ ...input, pitch: [{ reading: 'ガッコウ', position: 0 }] }).request?.pitch, 0);
  assert.equal(pronunciationTarget({ surface: '東京', reading: 'トウキョウ',
    pitch: [{ reading: 'とうきょう', position: 4 }] }).request?.pitch, 4);
  for (const pitch of [
    [{ reading: 'とうきょう', position: 5 }], // 4 mora, not 5 characters
    [{ reading: 'とうきょう', position: -1 }],
    [{ reading: 'とうきょう', position: 1.5 }],
    [{ reading: 'とうきょう', position: NaN }],
    [{ reading: 'とうきょ', position: 1 }],
    [{ reading: 'とうきょう', position: 0 }, { reading: 'とうきょう', position: 1 }],
  ]) {
    assert.equal(pronunciationTarget({ surface: '東京', reading: 'とうきょう', pitch }).request?.pitch, undefined);
  }
  assert.equal(pronunciationTarget({ surface: '行った', reading: 'いった', lemma: '行く',
    pitch: [{ reading: 'いった', position: 1 }] }).request?.pitch, undefined);
  assert.equal(pronunciationTarget({ surface: 'は', reading: 'は', isParticle: true,
    pitch: [{ reading: 'は', position: 1 }] }).request?.pitch, undefined);
});

test('changes は・へ・を only in analyzed particle context, including merged particle units', () => {
  for (const [surface, reading] of [['は', 'わ'], ['へ', 'え'], ['を', 'お']]) {
    assert.equal(pronunciationTarget({ surface, reading: surface, isParticle: true }).request?.reading, reading);
    assert.equal(pronunciationTarget({ surface, reading: surface }).request?.reading, surface);
  }
  assert.equal(pronunciationTarget({ surface: '歯', reading: 'は' }).request?.reading, 'は');
  assert.equal(pronunciationTarget({ surface: 'はな', reading: 'はな' }).request?.reading, 'はな');
  assert.equal(pronunciationTarget({ surface: 'には', reading: 'ニハ', isParticle: true, subTokens: [
    { surface: 'に', reading: 'ニ', posJa: '助詞' },
    { surface: 'は', reading: 'ハ', posJa: '助詞' },
  ] }).request?.reading, 'にわ');
});

test('pronounces the clicked inflected surface and its full reading, never its lemma', () => {
  assert.deepEqual(pronunciationTarget({
    surface: '食べなかった', reading: 'タベナカッタ', lemma: '食べる',
    pitch: [{ reading: 'たべる', position: 2 }],
  }), { request: { surface: '食べなかった', reading: 'たべなかった' } });
});

test('uses kana-only spelling when reading is missing, but disables ambiguous kanji and invalid readings', () => {
  assert.deepEqual(pronunciationTarget({ surface: 'ｺｰﾋｰ' }), {
    request: { surface: 'ｺｰﾋｰ', reading: 'こーひー' },
  });
  assert.deepEqual(pronunciationTarget({ surface: 'ガラス', reading: 'ガラス' }), {
    request: { surface: 'ガラス', reading: 'がらす' },
  });
  for (const input of [
    { surface: '生' }, { surface: '生', reading: '*' },
    { surface: 'かな', reading: 'kana' }, { surface: '' }, { surface: '123' },
  ]) {
    const result = pronunciationTarget(input);
    assert.equal(result.request, null);
    assert.ok(result.reason?.includes('读音'));
  }
});
