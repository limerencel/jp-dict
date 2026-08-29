/**
 * AI 问答面板。
 *
 * 流式文本只存在这个组件的本地 state 里，所以每个 token 不会波及阅读区。
 * SSE 用 fetch + ReadableStream 手动解析（EventSource 不支持 POST）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ChatMessage, ChatRequest } from '@shared/types';
import { errorText, streamChat } from '../api';
import { useAppState, useDispatch, useWordIndex } from '../state';
import { Markdown } from './Markdown';
import { IconSend, IconSparkle, IconStop } from './Icons';

/** 附带的原文上限，避免把几千字整段塞给模型 */
const MAX_CONTEXT_CHARS = 3000;

const QUICK_PROMPTS = [
  '解释这个语法',
  '这句话怎么翻译',
  '这个助词为什么用这个',
  '给我 3 个类似例句',
  '拆解这句的句子结构',
];

export function ChatPanel(): JSX.Element {
  const { analysis, selectedWordId, config, aiSeed } = useAppState();
  const dispatch = useDispatch();
  const { byId } = useWordIndex(analysis);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attach, setAttach] = useState(true);

  const acc = useRef('');
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const word = selectedWordId != null ? byId.get(selectedWordId) ?? null : null;
  const sentence =
    word && analysis ? analysis.sentences.find((s) => s.index === word.sentenceIndex) ?? null : null;

  const context = useMemo((): ChatRequest['context'] | undefined => {
    if (!attach) return undefined;
    const ctx: NonNullable<ChatRequest['context']> = {};
    if (analysis?.text) {
      ctx.fullText =
        analysis.text.length > MAX_CONTEXT_CHARS
          ? `${analysis.text.slice(0, MAX_CONTEXT_CHARS)}…（原文已截断）`
          : analysis.text;
    }
    if (sentence?.text) ctx.sentence = sentence.text;
    if (word) {
      ctx.focusWord = {
        surface: word.surface,
        reading: word.reading,
        lemma: word.lemma,
        posLabel: word.posLabel,
        brief: word.brief.slice(0, 3).map((b) => `${b.dictTitle}：${b.text}`),
      };
    }
    return Object.keys(ctx).length > 0 ? ctx : undefined;
  }, [analysis, attach, sentence, word]);

  const contextSummary = useMemo(() => {
    if (!context) return '未附带上下文';
    const parts: string[] = [];
    if (context.fullText) parts.push(`原文 ${context.fullText.length} 字`);
    if (context.sentence) parts.push(`当前句「${context.sentence.slice(0, 16)}」`);
    if (context.focusWord) parts.push(`焦点词「${context.focusWord.surface}」`);
    return `已附带：${parts.join(' · ')}`;
  }, [context]);

  const aiReady = config?.aiConfigured === true;

  const send = useCallback(
    (raw: string) => {
      const content = raw.trim();
      if (!content || busy) return;
      const next: ChatMessage[] = [...messages, { role: 'user', content }];
      setMessages(next);
      setInput('');
      setError(null);
      setStreaming('');
      setBusy(true);
      acc.current = '';

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      void streamChat(
        { messages: next, context },
        {
          signal: ctrl.signal,
          onDelta: (t) => {
            acc.current += t;
            setStreaming(acc.current);
          },
          onError: (m) => setError(m),
        },
      )
        .catch((err: unknown) => setError(errorText(err)))
        .finally(() => {
          const text = acc.current;
          acc.current = '';
          abortRef.current = null;
          setStreaming('');
          setBusy(false);
          if (text) setMessages((m) => [...m, { role: 'assistant', content: text }]);
        });
    },
    [busy, context, messages],
  );

  // 「问 AI」按钮把提示词塞进输入框
  useEffect(() => {
    if (!aiSeed) return;
    setInput(aiSeed.prompt);
    dispatch({ type: 'ai/seedConsumed' });
    window.setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 0);
    if (aiSeed.send) send(aiSeed.prompt);
    // send 会随 messages 变化，这里只在 seed 变化时执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiSeed]);

  // 自动滚到底部
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(input);
    }
  };

  if (config && !aiReady) {
    return (
      <div className="chat">
        <div className="chat-log">
          <div className="callout">
            <b style={{ color: 'var(--fg-strong)' }}>尚未配置 AI</b>
            <p style={{ margin: '6px 0' }}>
              在项目根目录创建 <code>.env</code>（可参考 <code>.env.example</code>），填入以下变量后重启后端：
            </p>
            <p style={{ margin: '4px 0' }}>
              <code>AI_BASE_URL=https://api.openai.com/v1</code>
              <br />
              <code>AI_API_KEY=sk-…</code>
              <br />
              <code>AI_MODEL=gpt-4o-mini</code>
            </p>
            <p style={{ margin: '6px 0 0' }} className="faint">
              任何兼容 OpenAI Chat Completions 的服务都可以，例如本地 Ollama、DeepSeek、通义等。
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat">
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && !streaming ? (
          <div className="empty">
            <IconSparkle width={30} height={30} />
            <p>
              选中一个词后提问，AI 会自动拿到原文、当前句和该词的解析结果。
              {config?.aiModel ? <br /> : null}
              {config?.aiModel ? <span className="faint">模型：{config.aiModel}</span> : null}
            </p>
          </div>
        ) : null}

        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div className="bubble user" key={i} style={{ whiteSpace: 'pre-wrap' }}>
              {m.content}
            </div>
          ) : (
            <div className="bubble assistant" key={i}>
              <Markdown text={m.content} />
            </div>
          ),
        )}

        {streaming ? (
          <div className="bubble assistant">
            <Markdown text={streaming} />
            <span className="caret" />
          </div>
        ) : busy ? (
          <div className="bubble assistant">
            <span className="spin" /> <span className="faint">思考中…</span>
          </div>
        ) : null}

        {error ? <div className="bubble error">{error}</div> : null}
      </div>

      <div className={attach && context ? 'chat-ctx on' : 'chat-ctx'}>
        <span className="cx" title={contextSummary}>
          {contextSummary}
        </span>
        <label className="switch">
          <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
          附带
        </label>
      </div>

      <div className="chat-quick">
        {QUICK_PROMPTS.map((p) => (
          <button key={p} type="button" disabled={busy} onClick={() => send(p)}>
            {p}
          </button>
        ))}
        {messages.length > 0 ? (
          <button type="button" disabled={busy} onClick={() => { setMessages([]); setError(null); }}>
            清空对话
          </button>
        ) : null}
      </div>

      <div className="chat-input">
        <textarea
          ref={inputRef}
          value={input}
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="问点什么…（Enter 发送，Shift + Enter 换行）"
          aria-label="向 AI 提问"
        />
        {busy ? (
          <button
            className="btn"
            type="button"
            onClick={() => abortRef.current?.abort()}
            title="停止生成"
          >
            <IconStop /> 停止
          </button>
        ) : (
          <button className="btn primary" type="button" disabled={!input.trim()} onClick={() => send(input)}>
            <IconSend /> 发送
          </button>
        )}
      </div>
    </div>
  );
}
