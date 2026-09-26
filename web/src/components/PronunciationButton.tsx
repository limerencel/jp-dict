import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { pronunciation } from '../api';
import {
  type PronunciationRequest,
  type PronunciationTarget,
} from '../lib/pronunciation';
import {
  createPronunciationController,
  type PronunciationController,
} from '../lib/pronunciationController';
import { IconVolume, IconVolumePlaying } from './Icons';

let globalController: PronunciationController | null = null;

function getGlobalController(): PronunciationController {
  if (!globalController) {
    globalController = createPronunciationController({
      request: (target, signal) => pronunciation(target, signal),
    });
  }
  return globalController;
}

export interface PronunciationButtonProps {
  id: string;
  target: PronunciationTarget | PronunciationRequest | null;
  size?: 'sm' | 'md';
  title?: string;
  showBadge?: boolean;
  className?: string;
}

const IDLE_SNAPSHOT = { id: null, target: null, status: 'idle' as const };

export function PronunciationButton({
  id,
  target,
  size = 'md',
  title,
  showBadge = false,
  className = '',
}: PronunciationButtonProps): JSX.Element {
  const controller = getGlobalController();
  const snapshot = useSyncExternalStore(
    (onStoreChange) => controller.subscribe(onStoreChange),
    () => controller.getSnapshot(),
    () => IDLE_SNAPSHOT,
  );

  const req: PronunciationRequest | null =
    target && 'request' in target ? target.request : (target as PronunciationRequest | null);
  const disabledReason =
    target && 'reason' in target && target.reason ? target.reason : null;

  const isCurrent = snapshot.id === id;
  const status = isCurrent ? snapshot.status : 'idle';
  const isPlaying = status === 'playing';
  const isLoading = status === 'loading';
  const hasError = status === 'error' && isCurrent && !!snapshot.error;

  const handleClick = useCallback(() => {
    if (!req) return;
    controller.activate(id, req);
  }, [controller, id, req]);

  const defaultTitle = !req
    ? disabledReason || '缺少有效读音'
    : isPlaying
      ? '正在播放，点击停止'
      : isLoading
        ? '正在合成音频…'
        : hasError
          ? `${snapshot.error || '失败'}，点击重试`
          : `朗读「${req.surface}」（${req.reading}）`;

  return (
    <span className={`pronounce-wrap ${className}`.trim()}>
      <button
        type="button"
        className={`btn-pronounce btn-pronounce-${size} ${isPlaying ? 'playing' : ''} ${isLoading ? 'loading' : ''} ${hasError ? 'error' : ''}`}
        disabled={!req}
        onClick={handleClick}
        title={title || defaultTitle}
        aria-label={title || defaultTitle}
        aria-busy={isLoading}
      >
        {isLoading ? (
          <span className="pronounce-spin" aria-hidden="true" />
        ) : isPlaying ? (
          <IconVolumePlaying className="pronounce-icon" />
        ) : (
          <IconVolume className="pronounce-icon" />
        )}
      </button>
      {showBadge ? (
        <span className="pronounce-badge" title="Google Cloud Chirp 3 HD · ja-JP-Chirp3-HD-Achernar">
          AI · Achernar
        </span>
      ) : null}
    </span>
  );
}
