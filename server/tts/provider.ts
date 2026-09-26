import { GoogleAuth } from 'google-auth-library';
import type { GoogleAuthOptions } from 'google-auth-library';

export const VOICE = 'ja-JP-Chirp3-HD-Achernar';
export const SYNTHESIS_IDENTITY = { version: 1, model: 'Chirp3-HD', voice: VOICE, languageCode: 'ja-JP', rate: 1, format: 'MP3' } as const;
export type Synthesizer = (ssml: string, signal: AbortSignal) => Promise<Buffer>;
export interface ProviderConfig { keyFilename: string; projectId: string }
export interface ProviderDependencies {
  createAuth?: (options: GoogleAuthOptions) => { getAccessToken(): Promise<string | null> };
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export function createGoogleSynthesizer(config: ProviderConfig, dependencies: ProviderDependencies = {}): Synthesizer {
  const auth = (dependencies.createAuth ?? (options => new GoogleAuth(options)))({
    keyFilename: config.keyFilename, projectId: config.projectId,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    clientOptions: { transporterOptions: { timeout: 10000, retry: false } },
  });
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  return async (ssml, signal) => {
    const token = await auth.getAccessToken();
    const response = await fetcher('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-goog-user-project': config.projectId },
      body: JSON.stringify({ input: { ssml }, voice: { languageCode: 'ja-JP', name: VOICE }, audioConfig: { audioEncoding: 'MP3', speakingRate: 1 } }),
    });
    const body = await response.json() as { audioContent: string };
    return Buffer.from(body.audioContent, 'base64');
  };
}
