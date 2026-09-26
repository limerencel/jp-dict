import { countMora, normalizeKana } from '../../../shared/kana';
import type { PitchAccent, SubToken } from '../../../shared/types';

/** Voice is fixed by the backend: ja-JP-Chirp3-HD-Achernar. */
export interface PronunciationRequest {
  surface: string;
  reading: string;
  pitch?: number;
}

export interface PronunciationInput {
  surface: string;
  reading?: string;
  lemma?: string;
  isParticle?: boolean;
  subTokens?: Pick<SubToken, 'surface' | 'reading' | 'posJa'>[];
  pitch?: Pick<PitchAccent, 'reading' | 'position'>[];
}

export interface PronunciationTarget {
  request: PronunciationRequest | null;
  reason?: string;
}

function kana(value: string): string {
  return normalizeKana(value.normalize('NFKC'));
}

export function pronunciationTarget(input: PronunciationInput): PronunciationTarget {
  let reading = kana(input.reading?.trim() || input.surface);
  if (!input.surface.trim() || !/^[ぁ-ゖー]+$/u.test(reading)) {
    return { request: null, reason: '缺少可靠的假名读音，暂不能播放' };
  }
  const particleReadings: Record<string, string> = { は: 'わ', へ: 'え', を: 'お' };
  const tokens = input.subTokens ?? [];
  // Only reconstruct when the analyzed pieces cover the exact clicked unit.
  if (tokens.length && tokens.map((t) => t.surface).join('') === input.surface &&
      kana(tokens.map((t) => t.reading).join('')) === reading) {
    reading = tokens.map((t) => t.posJa === '助詞'
      ? particleReadings[kana(t.surface)] ?? kana(t.reading)
      : kana(t.reading)).join('');
  } else if (input.isParticle) {
    reading = particleReadings[kana(input.surface)] ?? reading;
  }
  const request: PronunciationRequest = { surface: input.surface, reading };
  // Analysis pitch is often fetched for the lemma. Never carry it to an inflection.
  if (!input.lemma || input.lemma === input.surface) {
    const positions = new Set((input.pitch ?? [])
      .filter((p) => kana(p.reading) === reading && Number.isInteger(p.position) &&
        p.position >= 0 && p.position <= countMora(reading))
      .map((p) => p.position));
    if (positions.size === 1) request.pitch = [...positions][0];
  }
  return { request };
}
