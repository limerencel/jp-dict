/**
 * 输入区。初始态是页面中央的扉页式 composer，出结果后收成顶部 sticky 单行横条，
 * 聚焦时再展开。
 *
 * 输入法要点：日语 / 中文 IME 组字过程中按 Enter 只能用来确定候选，绝不能提交，
 * 因此同时看 composition 事件与 nativeEvent.isComposing 两道保险。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { useAppState, useDispatch } from '../state';
import { useTranslation } from './Translation';
import { IconSend } from './Icons';

/** 展开态最多约 12 行后内部滚动 */
const MAX_HEIGHT = 372;
/** 收起态单行高度，需与 styles.css 中 .composer.is-bar:not(.is-open) textarea 一致 */
const BAR_HEIGHT = 40;

export const COMPOSER_EXAMPLES = [
  '私は毎朝七時に学校へ行きます。',
  '先生に本を読ませられなかった。',
  '彼が作ってくれたお弁当はとてもおいしかったです。',
  '雨が降っているので、今日は出かけないつもりだ。',
];

interface Props {
  mode: 'hero' | 'bar';
  onAnalyze: (text: string) => void;
}

export function Composer({ mode, onAnalyze }: Props): JSX.Element {
  const { text, analyzing, config } = useAppState();
  const dispatch = useDispatch();
  const tr = useTranslation();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [open, setOpen] = useState(false);

  const bar = mode === 'bar';
  const expanded = !bar || open;

  const maxLen = config?.maxTextLength ?? 0;
  const len = [...text].length;
  const over = maxLen > 0 && len > maxLen;
  const canSubmit = text.trim().length > 0 && !analyzing && !over;

  const setText = useCallback(
    (value: string) => dispatch({ type: 'text/set', text: value }),
    [dispatch],
  );

  /* 高度自适应：收起态交回 CSS 控制 */
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    if (!expanded) {
      el.style.height = '';
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, BAR_HEIGHT), MAX_HEIGHT)}px`;
  }, [text, expanded, mode]);

  /* 从横条切回扉页态（清空后）时收起展开标记 */
  useEffect(() => {
    if (!bar) setOpen(false);
  }, [bar]);

  const submit = useCallback(() => {
    if (!canSubmit) return;
    setOpen(false);
    areaRef.current?.blur();
    onAnalyze(text);
  }, [canSubmit, onAnalyze, text]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    // 组字中：交给输入法确定候选
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submit();
  };

  const onBlur = (e: FocusEvent<HTMLDivElement>): void => {
    if (!bar) return;
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setOpen(false);
  };

  const placeholder = bar
    ? '修改原文后按 Enter 重新分析'
    : '在此粘贴或输入日语文本，可长可短。Enter 分析，Shift + Enter 换行。';

  return (
    <div
      className={`composer ${bar ? 'is-bar' : 'is-hero'}${open ? ' is-open' : ''}`}
      onBlur={onBlur}
    >
      <div className="composer-inner">
        <div className="composer-shell">
          <textarea
            ref={areaRef}
            value={text}
            rows={1}
            spellCheck={false}
            aria-label="日语原文"
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onFocus={() => setOpen(true)}
          />

          <div className="composer-bar">
            <span className={over ? 'count over' : 'count'}>
              {len.toLocaleString()}
              {maxLen > 0 ? ` / ${maxLen.toLocaleString()}` : ''}
            </span>
            {over ? <span className="count over">超出上限</span> : null}

            <span className="spacer" />

            {text ? (
              <button
                className="btn ghost sm"
                type="button"
                onClick={() => {
                  setText('');
                  dispatch({ type: 'analyze/clear' });
                  areaRef.current?.focus();
                }}
              >
                清空
              </button>
            ) : null}

            {tr.supported ? (
              <span className="selectwrap">
                <select
                  className="select"
                  value={tr.target}
                  aria-label="译文目标语言"
                  title="译文目标语言"
                  onChange={(e) => tr.setTarget(e.target.value)}
                >
                  {tr.targets.map((t) => (
                    <option key={t.code} value={t.code}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </span>
            ) : null}

            <button
              className="composer-send"
              type="button"
              disabled={!canSubmit}
              onClick={submit}
              title="分析（Enter）"
            >
              {analyzing ? <span className="spin" /> : <IconSend width={13} height={13} />}
              {analyzing ? '分析中' : '分析'}
            </button>
          </div>
        </div>
      </div>

      {!bar ? (
        <div className="composer-hint">
          <span className="kbd">Enter</span> 分析 · <span className="kbd">Shift</span>+
          <span className="kbd">Enter</span> 换行 · 输入法组字时 Enter 不会提交
        </div>
      ) : null}
    </div>
  );
}
