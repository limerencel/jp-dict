/**
 * 应用骨架：顶栏 + 单列舞台 + 可滑出的右侧详情栏。
 *
 * 布局取搜索引擎式：没有结果时 composer 居中偏上；出结果后 composer 收成顶部
 * sticky 横条，结果居中单列，点词从右侧滑出详情。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { analyze as apiAnalyze, errorText, getConfig } from './api';
import { MOCK_TEXT, mockAnalysis } from './mock';
import { useAppState, useDispatch } from './state';
import { Composer, COMPOSER_EXAMPLES } from './components/Composer';
import { ReadingView } from './components/ReadingView';
import { DetailPanel } from './components/DetailPanel';
import { DictionaryManager } from './components/DictionaryManager';
import { ErrorBoundary } from './components/ErrorBoundary';
import { IconBook, IconClose, IconMoon, IconPanelRight, IconSun } from './components/Icons';

export function App(): JSX.Element {
  const state = useAppState();
  const dispatch = useDispatch();
  const { config, configLoaded, configError, settings, dictManagerOpen, analysis } = state;
  const analyzeAbort = useRef<AbortController | null>(null);

  /* 启动时拉配置 */
  useEffect(() => {
    const ctrl = new AbortController();
    getConfig(ctrl.signal).then(
      (cfg) => dispatch({ type: 'config/loaded', config: cfg }),
      (err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        dispatch({ type: 'config/error', message: errorText(err) });
      },
    );
    return () => ctrl.abort();
  }, [dispatch]);

  const analyze = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      analyzeAbort.current?.abort();
      const ctrl = new AbortController();
      analyzeAbort.current = ctrl;
      dispatch({ type: 'analyze/start' });
      apiAnalyze(text, ctrl.signal).then(
        (result) => dispatch({ type: 'analyze/success', result, demo: false }),
        (err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          dispatch({ type: 'analyze/error', message: errorText(err) });
        },
      );
    },
    [dispatch],
  );

  const loadDemo = useCallback(() => {
    dispatch({ type: 'text/set', text: MOCK_TEXT });
    dispatch({ type: 'analyze/success', result: mockAnalysis(), demo: true });
  }, [dispatch]);

  useEffect(() => () => analyzeAbort.current?.abort(), []);

  /* 全局 Esc：先收侧栏，再清选中（输入框内不拦截） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || dictManagerOpen) return;
      const t = e.target;
      if (t instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(t.tagName)) return;
      dispatch({ type: 'word/select', wordId: null });
      dispatch({ type: 'settings/patch', patch: { rightOpen: false } });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dictManagerOpen, dispatch]);

  /* 侧栏宽度写到 :root，让 CSS 的窄屏媒体查询仍能覆盖 */
  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-w', `${settings.sidebarWidth}px`);
  }, [settings.sidebarWidth]);

  const toggle = (patch: Partial<typeof settings>): void => dispatch({ type: 'settings/patch', patch });

  const hasResult = analysis !== null;
  const sidebarOpen = hasResult && settings.rightOpen;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="seal" aria-hidden="true">
            解
          </span>
          <span className="name">日本語文法解析</span>
          <span className="sub">日语语法解析</span>
        </div>

        <div className="spacer" />

        <button className="btn" type="button" onClick={() => dispatch({ type: 'dict/open', open: true })}>
          <IconBook /> 词典
          {config && !config.dictReady ? (
            <span className="chiptag" style={{ color: 'var(--warn)' }}>
              未就绪
            </span>
          ) : null}
        </button>

        <button
          className="btn icon ghost"
          type="button"
          title={settings.theme === 'dark' ? '切换到日间' : '切换到夜间'}
          aria-label="切换主题"
          onClick={() => toggle({ theme: settings.theme === 'dark' ? 'light' : 'dark' })}
        >
          {settings.theme === 'dark' ? <IconSun /> : <IconMoon />}
        </button>

        {hasResult ? (
          <button
            className="btn icon ghost"
            type="button"
            title={settings.rightOpen ? '收起详情栏' : '展开详情栏'}
            aria-label="切换详情栏"
            onClick={() => toggle({ rightOpen: !settings.rightOpen })}
          >
            <IconPanelRight style={{ opacity: settings.rightOpen ? 1 : 0.45 }} />
          </button>
        ) : null}
      </header>

      <div className="workspace">
        <main className="stage">
          {configError || (configLoaded && config && !config.dictReady) ? (
            <div className="topbanners">
              {configError ? (
                <div className="banner error">
                  <span>✕</span>
                  <span>
                    无法读取服务端配置：{configError}
                    {import.meta.env.DEV ? '　（后端未启动时，可用下方的「演示数据」预览界面）' : ''}
                  </span>
                </div>
              ) : null}
              {configLoaded && config && !config.dictReady ? (
                <div className="banner warn">
                  <span>⚠</span>
                  <span>
                    当前没有可用词典，仅语法分析可用（无释义 / 声调 / 频率）。把 Yomitan 词典 zip 放进{' '}
                    <code>{config.dictDir}</code> 后在「词典」里重新扫描。
                  </span>
                  <span className="spacer" />
                  <button className="btn sm" type="button" onClick={() => dispatch({ type: 'dict/open', open: true })}>
                    去导入
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {hasResult ? (
            <>
              <Composer mode="bar" onAnalyze={analyze} />
              <ErrorBoundary resetKey={analysis} fallback={(e) => <PaneError what="解析结果" error={e} />}>
                <ReadingView />
              </ErrorBoundary>
            </>
          ) : (
            <Hero onAnalyze={analyze} onDemo={loadDemo} />
          )}
        </main>

        {sidebarOpen ? <Sidebar /> : null}
      </div>

      {sidebarOpen ? (
        <button
          className="scrim"
          type="button"
          aria-label="关闭详情栏"
          onClick={() => toggle({ rightOpen: false })}
        />
      ) : null}

      <DictionaryManager />
    </div>
  );
}

/* ────────────────────────────── 扉页 ────────────────────────────── */

function Hero({ onAnalyze, onDemo }: { onAnalyze: (text: string) => void; onDemo: () => void }): JSX.Element {
  const { analyzing, analyzeError } = useAppState();
  const dispatch = useDispatch();

  return (
    <div className="hero">
      <div className="hero-title">
        <h1>日本語文法解析</h1>
        <div className="rule" />
        <p>词典 · 活用 · 助词</p>
      </div>

      <Composer mode="hero" onAnalyze={onAnalyze} />

      {analyzeError ? (
        <div className="banner error" style={{ maxWidth: 720, width: '100%', marginTop: 14 }}>
          <span>✕</span>
          <span>{analyzeError}</span>
        </div>
      ) : null}

      <div className="examples">
        <span className="label">试试这些</span>
        {COMPOSER_EXAMPLES.map((s) => (
          <button
            key={s}
            type="button"
            disabled={analyzing}
            onClick={() => {
              dispatch({ type: 'text/set', text: s });
              onAnalyze(s);
            }}
          >
            {s}
          </button>
        ))}
        {import.meta.env.DEV ? (
          <button type="button" onClick={onDemo} title="载入内置演示数据（无需后端）">
            演示数据
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* ────────────────────────────── 右侧详情栏 ────────────────────────────── */

function Sidebar(): JSX.Element {
  const state = useAppState();
  const dispatch = useDispatch();
  const [dragging, setDragging] = useState(false);

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = state.settings.sidebarWidth;
    setDragging(true);
    const move = (ev: PointerEvent): void => {
      dispatch({ type: 'settings/patch', patch: { sidebarWidth: startW + (startX - ev.clientX) } });
    };
    const up = (): void => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <aside className="sidebar" aria-label="词条详情">
      <div
        className={dragging ? 'sidebar-resize is-dragging' : 'sidebar-resize'}
        role="separator"
        aria-orientation="vertical"
        aria-label="拖拽调整详情栏宽度"
        onPointerDown={startDrag}
      />

      <div className="sidebar-head">
        <span>词条详情</span>
        <span className="spacer" />
        <button
          className="btn icon ghost close"
          type="button"
          aria-label="关闭详情栏"
          title="关闭（Esc）"
          onClick={() => dispatch({ type: 'settings/patch', patch: { rightOpen: false } })}
        >
          <IconClose />
        </button>
      </div>

      <div className="sidebar-pane">
        <ErrorBoundary resetKey={state.selectedWordId} fallback={(e) => <PaneError what="词条详情" error={e} />}>
          <DetailPanel />
        </ErrorBoundary>
      </div>
    </aside>
  );
}

/** 单个区域崩溃时的兜底，不让整页白屏 */
function PaneError({ what, error }: { what: string; error: Error }): JSX.Element {
  return (
    <div className="empty" style={{ flex: 1 }}>
      <span className="big">!</span>
      <p>{what}渲染失败。可以重新分析或换一个词再试。</p>
      <p className="faint" style={{ fontSize: 11 }}>
        {error.message}
      </p>
    </div>
  );
}
