/**
 * 全局状态：单个 reducer + 两个 context（值 / dispatch 分开，避免只用 dispatch 的
 * 组件跟着状态变化重渲染）。刻意不引第三方状态库。
 *
 * 注意：高频变化的状态（聊天流式文本、hover）**不放在这里**，
 * 否则几千个词 chip 会跟着整树 reconcile。
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';
import type { AnalysisResult, Word } from '@shared/types';
import type { AppConfig } from './api';

export type FuriganaMode = 'all' | 'unknown' | 'off';
export type Theme = 'dark' | 'light';
export type RightTab = 'detail' | 'ai';

export interface Settings {
  furigana: FuriganaMode;
  showArcs: boolean;
  /** 词性图例是否展开 */
  showLegend: boolean;
  /** 是否在每句下方显示译文 */
  showTranslation: boolean;
  /** 目标语言，空串表示跟随服务端默认 */
  translateTarget: string;
  /** 翻译服务商，空串表示由服务端自动选择 */
  translateProvider: string;
  theme: Theme;
  leftOpen: boolean;
  /** 右侧详情栏是否展开 */
  rightOpen: boolean;
  /** 右侧详情栏宽度（仅宽屏生效） */
  sidebarWidth: number;
}

/** 传给 AI 面板的一次性指令（key 用于区分重复的同一句提问） */
export interface AiSeed {
  key: number;
  prompt: string;
  wordId: number | null;
  send: boolean;
}

export interface AppState {
  config: AppConfig | null;
  configLoaded: boolean;
  configError: string | null;
  text: string;
  analysis: AnalysisResult | null;
  analyzing: boolean;
  analyzeError: string | null;
  /** 当前结果来自内置演示数据 */
  demo: boolean;
  selectedWordId: number | null;
  rightTab: RightTab;
  aiSeed: AiSeed | null;
  dictManagerOpen: boolean;
  settings: Settings;
}

export type Action =
  | { type: 'config/loaded'; config: AppConfig }
  | { type: 'config/error'; message: string }
  | { type: 'config/patch'; patch: Partial<AppConfig> }
  | { type: 'text/set'; text: string }
  | { type: 'analyze/start' }
  | { type: 'analyze/success'; result: AnalysisResult; demo: boolean }
  | { type: 'analyze/error'; message: string }
  | { type: 'analyze/clear' }
  | { type: 'word/select'; wordId: number | null }
  | { type: 'tab/set'; tab: RightTab }
  | { type: 'ai/seed'; prompt: string; wordId: number | null; send: boolean }
  | { type: 'ai/seedConsumed' }
  | { type: 'dict/open'; open: boolean }
  | { type: 'settings/patch'; patch: Partial<Settings> };

const SETTINGS_KEY = 'jp-sentence.settings';
const TEXT_KEY = 'jp-sentence.text';
const THEME_KEY = 'jp-sentence.theme';

const DEFAULT_SETTINGS: Settings = {
  furigana: 'all',
  showArcs: false,
  showLegend: false,
  showTranslation: false,
  translateTarget: '',
  translateProvider: '',
  theme: 'dark',
  leftOpen: true,
  rightOpen: false,
  sidebarWidth: 440,
};

export const SIDEBAR_MIN = 340;
export const SIDEBAR_MAX = 720;

function clampWidth(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_SETTINGS.sidebarWidth;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)));
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_SETTINGS;
    const merged = { ...DEFAULT_SETTINGS, ...(parsed as Partial<Settings>) };
    merged.sidebarWidth = clampWidth(merged.sidebarWidth);
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadText(): string {
  try {
    return localStorage.getItem(TEXT_KEY) ?? '';
  } catch {
    return '';
  }
}

export const initialState: AppState = {
  config: null,
  configLoaded: false,
  configError: null,
  text: loadText(),
  analysis: null,
  analyzing: false,
  analyzeError: null,
  demo: false,
  selectedWordId: null,
  rightTab: 'detail',
  aiSeed: null,
  dictManagerOpen: false,
  settings: loadSettings(),
};

let seedSeq = 0;

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'config/loaded':
      return { ...state, config: action.config, configLoaded: true, configError: null };
    case 'config/error':
      return { ...state, configLoaded: true, configError: action.message };
    case 'config/patch':
      return state.config ? { ...state, config: { ...state.config, ...action.patch } } : state;
    case 'text/set':
      return { ...state, text: action.text };
    case 'analyze/start':
      return { ...state, analyzing: true, analyzeError: null };
    case 'analyze/success':
      return {
        ...state,
        analyzing: false,
        analyzeError: null,
        analysis: action.result,
        demo: action.demo,
        selectedWordId: null,
        // 新结果没有选中词，详情栏留着就是一块空白；AI 会话则保持可见
        settings:
          state.rightTab === 'ai' ? state.settings : { ...state.settings, rightOpen: false },
      };
    case 'analyze/error':
      return { ...state, analyzing: false, analyzeError: action.message };
    case 'analyze/clear':
      return {
        ...state,
        analysis: null,
        analyzeError: null,
        selectedWordId: null,
        demo: false,
        settings: { ...state.settings, rightOpen: false },
      };
    case 'word/select': {
      // 选词即展开侧栏；重复点同一个词也能把收起的侧栏重新拉出来
      const wantOpen = action.wordId != null;
      const needOpen = wantOpen && !state.settings.rightOpen;
      if (state.selectedWordId === action.wordId && !needOpen) return state;
      return {
        ...state,
        selectedWordId: action.wordId,
        settings: needOpen ? { ...state.settings, rightOpen: true } : state.settings,
      };
    }
    case 'tab/set':
      return { ...state, rightTab: action.tab };
    case 'ai/seed':
      return {
        ...state,
        rightTab: 'ai',
        settings: { ...state.settings, rightOpen: true },
        aiSeed: { key: ++seedSeq, prompt: action.prompt, wordId: action.wordId, send: action.send },
      };
    case 'ai/seedConsumed':
      return { ...state, aiSeed: null };
    case 'dict/open':
      return { ...state, dictManagerOpen: action.open };
    case 'settings/patch': {
      const next = { ...state.settings, ...action.patch };
      if (action.patch.sidebarWidth !== undefined) next.sidebarWidth = clampWidth(next.sidebarWidth);
      return { ...state, settings: next };
    }
    default:
      return state;
  }
}

const StateContext = createContext<AppState>(initialState);
const DispatchContext = createContext<Dispatch<Action>>(() => undefined);

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
      localStorage.setItem(THEME_KEY, state.settings.theme);
    } catch {
      /* 隐私模式下 localStorage 可能不可写 */
    }
    document.documentElement.dataset.theme = state.settings.theme;
  }, [state.settings]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(TEXT_KEY, state.text.slice(0, 20000));
      } catch {
        /* 忽略 */
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [state.text]);

  return (
    <DispatchContext.Provider value={dispatch}>
      <StateContext.Provider value={state}>{children}</StateContext.Provider>
    </DispatchContext.Provider>
  );
}

export function useAppState(): AppState {
  return useContext(StateContext);
}

export function useDispatch(): Dispatch<Action> {
  return useContext(DispatchContext);
}

/* ────────────────────────────── 派生数据 ────────────────────────────── */

export interface WordIndex {
  byId: Map<number, Word>;
  /** 句子 index → 该句的词（按出现顺序） */
  bySentence: Map<number, Word[]>;
}

export function useWordIndex(analysis: AnalysisResult | null): WordIndex {
  return useMemo(() => {
    const byId = new Map<number, Word>();
    const bySentence = new Map<number, Word[]>();
    if (analysis) {
      for (const w of analysis.words) {
        byId.set(w.id, w);
        const list = bySentence.get(w.sentenceIndex);
        if (list) list.push(w);
        else bySentence.set(w.sentenceIndex, [w]);
      }
    }
    return { byId, bySentence };
  }, [analysis]);
}
