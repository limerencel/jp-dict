/**
 * 译文接入。
 *
 * - 开关 / 目标语言存在 settings 里（持久化），服务商由服务端自动选择
 * - 结果按「服务商|语言|原句」缓存在模块级 Map，切语言或换服务商才会重新请求
 * - 一次最多提交 BATCH 条，超出自动分批（服务端上限 200）
 * - 演示数据不发真实请求
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { errorText, translate as apiTranslate } from '../api';
import { useAppState, useDispatch, useWordIndex } from '../state';
import { IconRefresh, IconTranslate } from './Icons';

/** 单批条数，留出余量避开服务端 200 条上限 */
const BATCH = 100;

const CACHE = new Map<string, string>();
const cacheKey = (provider: string, target: string, text: string): string =>
  `${provider}\u0000${target}\u0000${text}`;

export interface TranslationValue {
  /** 后端提供了翻译能力 */
  supported: boolean;
  /** 当前上下文允许真的发请求（非演示数据） */
  live: boolean;
  enabled: boolean;
  target: string;
  targets: { code: string; label: string }[];
  providerLabel: string;
  notice: string;
  loading: boolean;
  error: string | null;
  /** 下标 = 句子 index */
  lines: readonly (string | undefined)[];
  setEnabled: (on: boolean) => void;
  setTarget: (code: string) => void;
  retry: () => void;
  /** 单句按需翻译（侧栏「翻译这句」用） */
  translateOne: (text: string) => Promise<string>;
}

const EMPTY: TranslationValue = {
  supported: false,
  live: false,
  enabled: false,
  target: 'zh-CN',
  targets: [],
  providerLabel: '',
  notice: '',
  loading: false,
  error: null,
  lines: [],
  setEnabled: () => undefined,
  setTarget: () => undefined,
  retry: () => undefined,
  translateOne: () => Promise.resolve(''),
};

const TranslationContext = createContext<TranslationValue>(EMPTY);

export function useTranslation(): TranslationValue {
  return useContext(TranslationContext);
}

interface Batch {
  lines: (string | undefined)[];
  loading: boolean;
  error: string | null;
  notice: string;
  providerLabel: string;
}

const IDLE: Batch = { lines: [], loading: false, error: null, notice: '', providerLabel: '' };

export function TranslationProvider({ children }: { children: ReactNode }): JSX.Element {
  const { analysis, demo, config, settings } = useAppState();
  const dispatch = useDispatch();
  const [batch, setBatch] = useState<Batch>(IDLE);
  const [attempt, setAttempt] = useState(0);

  const cfg = config?.translate;
  const supported = !!cfg && cfg.targets.length > 0;
  const target = settings.translateTarget || cfg?.target || 'zh-CN';
  const provider = settings.translateProvider;
  const enabled = settings.showTranslation;
  const live = supported && !demo;

  const sentences = useMemo(() => analysis?.sentences.map((s) => s.text) ?? [], [analysis]);

  useEffect(() => {
    if (!enabled || !live || sentences.length === 0) {
      setBatch(IDLE);
      return;
    }

    const cached = sentences.map((t) => CACHE.get(cacheKey(provider, target, t)));
    const missing: number[] = [];
    cached.forEach((v, i) => {
      if (v === undefined) missing.push(i);
    });

    if (missing.length === 0) {
      setBatch({ lines: cached, loading: false, error: null, notice: '', providerLabel: '' });
      return;
    }

    setBatch((prev) => ({ ...prev, lines: cached, loading: true, error: null }));

    const ctrl = new AbortController();
    void (async () => {
      const acc = [...cached];
      let notice = '';
      let providerLabel = '';
      try {
        for (let i = 0; i < missing.length; i += BATCH) {
          const slice = missing.slice(i, i + BATCH);
          const res = await apiTranslate(
            { texts: slice.map((k) => sentences[k]), target, provider: provider || undefined },
            ctrl.signal,
          );
          providerLabel = res.providerLabel;
          if (res.notice) notice = res.notice;
          slice.forEach((k, j) => {
            const text = res.translations[j] ?? '';
            acc[k] = text;
            CACHE.set(cacheKey(provider, target, sentences[k]), text);
            CACHE.set(cacheKey(res.provider, res.target, sentences[k]), text);
          });
          if (ctrl.signal.aborted) return;
          setBatch({ lines: [...acc], loading: true, error: null, notice, providerLabel });
        }
        if (!ctrl.signal.aborted) {
          setBatch({ lines: acc, loading: false, error: null, notice, providerLabel });
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setBatch({ lines: acc, loading: false, error: errorText(err), notice, providerLabel });
      }
    })();

    return () => ctrl.abort();
  }, [enabled, live, sentences, target, provider, attempt]);

  const setEnabled = useCallback(
    (on: boolean) => dispatch({ type: 'settings/patch', patch: { showTranslation: on } }),
    [dispatch],
  );
  const setTarget = useCallback(
    (code: string) => dispatch({ type: 'settings/patch', patch: { translateTarget: code } }),
    [dispatch],
  );
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const translateOne = useCallback(
    async (text: string): Promise<string> => {
      const hit = CACHE.get(cacheKey(provider, target, text));
      if (hit !== undefined) return hit;
      const res = await apiTranslate({ texts: [text], target, provider: provider || undefined });
      const out = res.translations[0] ?? '';
      CACHE.set(cacheKey(provider, target, text), out);
      CACHE.set(cacheKey(res.provider, res.target, text), out);
      return out;
    },
    [provider, target],
  );

  const value = useMemo<TranslationValue>(
    () => ({
      supported,
      live,
      enabled,
      target,
      targets: cfg?.targets ?? [],
      providerLabel: batch.providerLabel || providerLabelOf(cfg?.providers, cfg?.active),
      notice: batch.notice,
      loading: batch.loading,
      error: batch.error,
      lines: batch.lines,
      setEnabled,
      setTarget,
      retry,
      translateOne,
    }),
    [supported, live, enabled, target, cfg, batch, setEnabled, setTarget, retry, translateOne],
  );

  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}

function providerLabelOf(
  providers: { id: string; label: string }[] | undefined,
  active: string | undefined,
): string {
  if (!providers || !active) return '';
  return providers.find((p) => p.id === active)?.label ?? active;
}

/* ────────────────────────────── 工具条控件 ────────────────────────────── */

export function TranslationControls(): JSX.Element | null {
  const tr = useTranslation();
  if (!tr.supported) return null;

  return (
    <div className="group">
      <button
        className="tgl"
        type="button"
        aria-pressed={tr.enabled}
        onClick={() => tr.setEnabled(!tr.enabled)}
        title="在每句解析结果下方显示译文"
      >
        <IconTranslate width={12} height={12} /> 译文
      </button>

      {tr.enabled ? (
        <>
          <span className="selectwrap">
            <select
              className="select"
              value={tr.target}
              aria-label="译文目标语言"
              onChange={(e) => tr.setTarget(e.target.value)}
            >
              {tr.targets.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.label}
                </option>
              ))}
            </select>
          </span>
          {tr.loading ? <span className="spin" /> : null}
          {tr.providerLabel ? (
            <span className="provider" title={tr.providerLabel}>
              {tr.providerLabel}
            </span>
          ) : null}
          {tr.error ? (
            <button className="btn sm" type="button" onClick={tr.retry}>
              <IconRefresh width={12} height={12} /> 重试
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** 工具条下方的一行淡提示（降级说明 / 演示模式 / 错误） */
export function TranslationNotice(): JSX.Element | null {
  const tr = useTranslation();
  const { demo } = useAppState();
  if (!tr.enabled || !tr.supported) return null;
  if (demo) return <div className="toolbar-note">演示数据不会请求翻译服务。</div>;
  if (tr.error) return <div className="toolbar-note" style={{ color: 'var(--danger)' }}>译文获取失败：{tr.error}</div>;
  if (tr.notice) return <div className="toolbar-note">{tr.notice}</div>;
  return null;
}

/* ────────────────────────────── 侧栏：翻译当前句 ────────────────────────────── */

export function SentenceTranslateCard(): JSX.Element | null {
  const { analysis, selectedWordId, demo } = useAppState();
  const { byId } = useWordIndex(analysis);
  const tr = useTranslation();

  const [out, setOut] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const jobRef = useRef(0);

  const word = selectedWordId != null ? byId.get(selectedWordId) ?? null : null;
  const sentence =
    word && analysis ? analysis.sentences.find((s) => s.index === word.sentenceIndex) ?? null : null;
  const text = sentence?.text ?? '';

  // 换句 / 换语言时清空上一次结果
  useEffect(() => {
    setOut(null);
    setErr(null);
    jobRef.current += 1;
  }, [text, tr.target]);

  if (!tr.supported || !text) return null;

  const run = (): void => {
    if (demo) {
      setErr('演示数据不会请求翻译服务。');
      return;
    }
    const job = ++jobRef.current;
    setBusy(true);
    setErr(null);
    tr.translateOne(text)
      .then((v) => {
        if (jobRef.current === job) setOut(v);
      })
      .catch((e: unknown) => {
        if (jobRef.current === job) setErr(errorText(e));
      })
      .finally(() => {
        if (jobRef.current === job) setBusy(false);
      });
  };

  return (
    <div className="trcard">
      <div className="row">
        <span className="src" title={text}>
          {text}
        </span>
        <button className="btn sm" type="button" disabled={busy} onClick={run}>
          {busy ? <span className="spin" /> : <IconTranslate width={12} height={12} />} 翻译这句
        </button>
      </div>
      {err ? <div className="out is-error">{err}</div> : null}
      {out !== null && !err ? <div className="out">{out || '（无译文）'}</div> : null}
    </div>
  );
}
