import { splitMora, toHiragana } from '../../shared/kana.ts';
import { PronunciationError } from './errors.ts';

export interface Pronunciation {
  surface: string;
  reading: string;
  ssml: string;
  characters: number;
}

const KANA = /^[ぁ-ゖー]+$/u;
const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

export function preparePronunciation(value: unknown): Pronunciation {
  const invalid = () => new PronunciationError(400, 'Invalid pronunciation: supply a surface and kana reading of at most 80 characters, with an optional valid mora pitch.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['surface', 'reading', 'pitch'].includes(key))) throw invalid();
  const { surface, pitch } = body;
  if (typeof surface !== 'string' || !surface.trim() || surface.length > 160 || [...surface].length > 80
    || /[\p{Cc}\p{Cf}\p{Cs}\uFFFE\uFFFF]/u.test(surface)) throw invalid();
  if (body.reading !== undefined && typeof body.reading !== 'string') throw invalid();
  const rawReading = (body.reading as string | undefined) || surface;
  if (rawReading.length > 160 || [...rawReading].length > 80) throw invalid();
  const reading = toHiragana(rawReading.normalize('NFKC'));
  if (!KANA.test(reading) || [...reading].length > 80) throw invalid();
  const mora = splitMora(reading);
  let phoneme = reading;
  if (Object.hasOwn(body, 'pitch')) {
    if (typeof pitch !== 'number' || !Number.isInteger(pitch) || pitch < 0 || pitch > mora.length) throw invalid();
    phoneme = '^' + (pitch === 0 ? reading : mora.slice(0, pitch).join('') + '!' + mora.slice(pitch).join(''));
  }
  const escaped = surface.replace(/[&<>"']/g, ch => XML_ESCAPES[ch]!);
  const ssml = `<speak><phoneme alphabet="yomigana" ph="${phoneme}">${escaped}</phoneme></speak>`;
  // Markup and both the written surface and reading are charged conservatively.
  return { surface, reading, ssml, characters: [...ssml].length };
}
