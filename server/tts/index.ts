import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { DATA_DIR } from '../config.ts';
import { createPronunciationHandler } from './handler.ts';
import { createGoogleSynthesizer } from './provider.ts';
import { PronunciationStore } from './store.ts';

let storeInstance: PronunciationStore | null = null;
let handlerInstance: ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) | null = null;

export function initPronunciation(): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  if (handlerInstance) return handlerInstance;

  const keyFilename =
    process.env.GOOGLE_APPLICATION_CREDENTIALS || '/root/.config/jp-dict/google-tts.json';
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || 'bound-to-hk-payment';
  const hasKey = fs.existsSync(keyFilename);
  const enabledEnv = process.env.JP_TTS_ENABLED;
  const enabled = enabledEnv === 'true' || (enabledEnv !== 'false' && hasKey);

  if (enabled && hasKey) {
    const cacheDir = process.env.JP_TTS_CACHE_DIR || path.join(DATA_DIR, 'tts');
    const dailyLimit = Number(process.env.JP_TTS_DAILY_CHARS || 10000);
    const monthlyLimit = Number(process.env.JP_TTS_MONTHLY_CHARS || 200000);

    const synthesizer = createGoogleSynthesizer({ keyFilename, projectId });
    storeInstance = new PronunciationStore({
      cacheDir,
      dailyCharLimit: dailyLimit,
      monthlyCharLimit: monthlyLimit,
      synthesizer,
    });
  }

  handlerInstance = createPronunciationHandler({
    enabled: enabled && hasKey,
    store: storeInstance as PronunciationStore,
    allowedOrigin: process.env.JP_PUBLIC_ORIGIN || 'https://jp.itsuhiro.com',
  });

  return handlerInstance;
}

export async function handlePronunciation(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const handler = initPronunciation();
  await handler(req, res);
}

export function closePronunciation(): void {
  if (storeInstance) {
    storeInstance.close();
    storeInstance = null;
  }
  handlerInstance = null;
}
