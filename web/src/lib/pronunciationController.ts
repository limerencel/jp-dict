import type { PronunciationRequest } from './pronunciation.ts';

export interface PronunciationAudio {
  src: string;
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

export type PronunciationStatus = 'idle' | 'loading' | 'playing' | 'ready' | 'error';

export interface PronunciationSnapshot {
  id: string | null;
  target: PronunciationRequest | null;
  status: PronunciationStatus;
  error?: string;
}

export interface PronunciationControllerDependencies {
  request: (target: PronunciationRequest, signal: AbortSignal) => Promise<Blob>;
  createAudio?: () => PronunciationAudio;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}

function targetKey(target: PronunciationRequest | null): string {
  if (!target) return '';
  return `${target.surface}\u0000${target.reading}\u0000${target.pitch ?? ''}`;
}

export class PronunciationController {
  private requestFn: (target: PronunciationRequest, signal: AbortSignal) => Promise<Blob>;
  private createAudioFn: () => PronunciationAudio;
  private createObjectURLFn: (blob: Blob) => string;
  private revokeObjectURLFn: (url: string) => void;

  private snapshot: PronunciationSnapshot = {
    id: null,
    target: null,
    status: 'idle',
  };

  private activeAbortCtrl: AbortController | null = null;
  private audio: PronunciationAudio | null = null;
  private currentBlob: Blob | null = null;
  private currentBlobUrl: string | null = null;
  private cachedBlobs = new Map<string, Blob>();

  private listeners = new Set<() => void>();

  constructor(deps: PronunciationControllerDependencies) {
    this.requestFn = deps.request;
    this.createAudioFn = deps.createAudio ?? (() => new Audio());
    this.createObjectURLFn = deps.createObjectURL ?? ((b) => URL.createObjectURL(b));
    this.revokeObjectURLFn = deps.revokeObjectURL ?? ((u) => URL.revokeObjectURL(u));
  }

  public getSnapshot(): PronunciationSnapshot {
    return this.snapshot;
  }

  private setSnapshot(next: PronunciationSnapshot): void {
    this.snapshot = next;
    this.notify();
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  private ensureAudio(): PronunciationAudio {
    if (!this.audio) {
      this.audio = this.createAudioFn();
      this.audio.addEventListener('ended', this.handleAudioEnded);
      this.audio.addEventListener('error', this.handleAudioError);
      this.audio.addEventListener('pause', this.handleAudioPause);
    }
    return this.audio;
  }

  private handleAudioEnded = () => {
    if (this.snapshot.status === 'playing') {
      this.setSnapshot({ ...this.snapshot, status: 'ready' });
    }
  };

  private handleAudioError = () => {
    if (this.snapshot.status === 'playing' || this.snapshot.status === 'loading') {
      this.setSnapshot({ ...this.snapshot, status: 'error', error: '音频播放失败，请重试' });
    }
  };

  private handleAudioPause = () => {
    if (this.snapshot.status === 'playing') {
      this.setSnapshot({ ...this.snapshot, status: 'ready' });
    }
  };

  public stop(): void {
    if (this.activeAbortCtrl) {
      this.activeAbortCtrl.abort();
      this.activeAbortCtrl = null;
    }
    if (this.audio) {
      this.audio.pause();
    }
    if (this.snapshot.status === 'loading' || this.snapshot.status === 'playing') {
      this.setSnapshot({ ...this.snapshot, status: this.currentBlob ? 'ready' : 'idle' });
    }
  }

  public async activate(id: string, target: PronunciationRequest): Promise<void> {
    const key = targetKey(target);
    const sameTarget = this.snapshot.id === id && targetKey(this.snapshot.target) === key;

    // 1. 如果正在播放相同目标，点击则暂停/重置
    if (sameTarget && this.snapshot.status === 'playing') {
      this.stop();
      return;
    }

    // 2. 如果之前在请求别的内容或播放别的目标，先中止
    if (this.activeAbortCtrl) {
      this.activeAbortCtrl.abort();
      this.activeAbortCtrl = null;
    }
    if (this.audio) {
      this.audio.pause();
    }

    // 3. 检查是否有已有 Blob 缓存（内存中保留）
    let blob = this.cachedBlobs.get(key) ?? null;

    if (!blob) {
      this.setSnapshot({ id, target, status: 'loading', error: undefined });

      const ctrl = new AbortController();
      this.activeAbortCtrl = ctrl;

      try {
        blob = await this.requestFn(target, ctrl.signal);
        this.cachedBlobs.set(key, blob);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        this.setSnapshot({
          id,
          target,
          status: 'error',
          error: err instanceof Error ? err.message : '获取发音失败',
        });
        return;
      } finally {
        if (this.activeAbortCtrl === ctrl) {
          this.activeAbortCtrl = null;
        }
      }
    }

    // 4. 准备播放
    if (this.currentBlobUrl) {
      this.revokeObjectURLFn(this.currentBlobUrl);
      this.currentBlobUrl = null;
    }

    this.currentBlob = blob;
    this.currentBlobUrl = this.createObjectURLFn(blob);

    const audio = this.ensureAudio();
    audio.src = this.currentBlobUrl;
    audio.currentTime = 0;

    try {
      this.setSnapshot({ id, target, status: 'playing', error: undefined });
      await audio.play();
    } catch (err: any) {
      // 在 Safari 等由于非同步手势限制导致自动 play 失败时，进入 ready 状态提示再次点击播放
      if (err?.name === 'NotAllowedError') {
        this.setSnapshot({
          id,
          target,
          status: 'ready',
          error: '音频已就绪，请再次点击播放',
        });
      } else {
        this.setSnapshot({
          id,
          target,
          status: 'error',
          error: '播放被中断或不支持',
        });
      }
    }
  }

  public dispose(): void {
    this.stop();
    if (this.currentBlobUrl) {
      this.revokeObjectURLFn(this.currentBlobUrl);
      this.currentBlobUrl = null;
    }
    if (this.audio) {
      this.audio.removeEventListener('ended', this.handleAudioEnded);
      this.audio.removeEventListener('error', this.handleAudioError);
      this.audio.removeEventListener('pause', this.handleAudioPause);
      this.audio.removeAttribute('src');
      this.audio.load();
      this.audio = null;
    }
    this.listeners.clear();
    this.cachedBlobs.clear();
  }
}

export function createPronunciationController(
  deps: PronunciationControllerDependencies,
): PronunciationController {
  return new PronunciationController(deps);
}
