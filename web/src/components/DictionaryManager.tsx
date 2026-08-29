/** 词典管理模态框：列出、启停、调优先级、删除、重新扫描目录。 */
import { useCallback, useEffect, useState } from 'react';
import type { DictionaryKind, DictionaryMeta } from '@shared/types';
import {
  deleteDictionary,
  errorText,
  listDictionaries,
  rescanDictionaries,
  updateDictionary,
  type RescanResponse,
} from '../api';
import { useAppState, useDispatch } from '../state';
import { IconArrowDown, IconArrowUp, IconClose, IconRefresh, IconTrash } from './Icons';

const KIND_LABEL: Record<DictionaryKind, string> = {
  term: '词条',
  kanji: '汉字',
  frequency: '频率',
  pitch: '声调',
  mixed: '混合',
};

const RECOMMENDED = [
  '明鏡国語辞典',
  '新明解国語辞典',
  '大辞林',
  'JMdict（日英）',
  'JMnedict（人名地名）',
  'NHK日本語発音アクセント辞典',
  'CC-CEDICT / 中日辞典',
  'Kanjium 音调词典',
  '频率词典 JPDB / BCCWJ',
];

export function DictionaryManager(): JSX.Element | null {
  const { dictManagerOpen, config } = useAppState();
  const dispatch = useDispatch();

  const [items, setItems] = useState<DictionaryMeta[]>([]);
  const [dictDir, setDictDir] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState<RescanResponse | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);

  const close = useCallback(() => dispatch({ type: 'dict/open', open: false }), [dispatch]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const res = await listDictionaries(signal);
        setItems(res.dictionaries);
        setDictDir(res.dictDir);
        dispatch({ type: 'config/patch', patch: { dictReady: res.ready, dictDir: res.dictDir } });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(errorText(err));
      } finally {
        setLoading(false);
      }
    },
    [dispatch],
  );

  useEffect(() => {
    if (!dictManagerOpen) return;
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [dictManagerOpen, load]);

  useEffect(() => {
    if (!dictManagerOpen) return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, dictManagerOpen]);

  if (!dictManagerOpen) return null;

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const patch = (id: number, p: { enabled?: boolean; priority?: number }): void => {
    void run(async () => {
      const updated = await updateDictionary(id, p);
      setItems((list) => list.map((d) => (d.id === id ? updated : d)));
    });
  };

  const move = (dict: DictionaryMeta, delta: number): void => {
    patch(dict.id, { priority: dict.priority + delta });
  };

  const remove = (id: number): void => {
    void run(async () => {
      await deleteDictionary(id);
      setItems((list) => list.filter((d) => d.id !== id));
      setConfirmId(null);
      await load();
    });
  };

  const rescan = (): void => {
    void run(async () => {
      setScan(null);
      const res = await rescanDictionaries();
      setScan(res);
      await load();
    });
  };

  const sorted = [...items].sort((a, b) => b.priority - a.priority || a.id - b.id);
  const dir = dictDir || config?.dictDir || '<dictDir>';

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="词典管理" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>词典管理</h2>
          <span className="chiptag">{items.length} 部</span>
          <span style={{ flex: 1 }} />
          <button className="btn" type="button" onClick={rescan} disabled={busy}>
            {busy ? <span className="spin" /> : <IconRefresh />} 重新扫描目录
          </button>
          <button className="btn icon ghost" type="button" onClick={close} aria-label="关闭">
            <IconClose />
          </button>
        </div>

        <div className="modal-body">
          <div className="callout">
            把 Yomitan 词典 <b>zip</b> 或 MDict 词典 <b>mdx</b> 放进 <code>{dir}</code>，然后点右上角「重新扫描目录」即可导入。MDX 的配套 CSS/MDD 请放在同一文件夹。
            <div className="reco">
              <span className="faint">推荐：</span>
              {RECOMMENDED.map((r) => (
                <span className="chiptag" key={r}>
                  {r}
                </span>
              ))}
            </div>
          </div>

          {error ? (
            <div className="banner error" style={{ margin: '10px 0 0' }}>
              <span>✕</span>
              <span>{error}</span>
            </div>
          ) : null}

          {scan ? (
            <div className="import-result">
              <div className="callout">
                <div>
                  导入 <b style={{ color: 'var(--ok)' }}>{scan.imported.length}</b> 部，跳过 {scan.skipped.length} 个，
                  失败 {scan.failed.length} 个。
                </div>
                {scan.imported.length > 0 ? (
                  <ul>
                    {scan.imported.map((d) => (
                      <li key={d.id}>
                        {d.title}（{d.termCount.toLocaleString()} 词条）
                      </li>
                    ))}
                  </ul>
                ) : null}
                {scan.failed.length > 0 ? (
                  <ul style={{ color: 'var(--danger)' }}>
                    {scan.failed.map((f) => (
                      <li key={f.file}>
                        {f.file}：{f.error}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          ) : null}

          {loading ? (
            <div className="loading-row">
              <span className="spin" /> 正在读取词典列表…
            </div>
          ) : sorted.length === 0 ? (
            <div className="empty">
              <span className="big">辞</span>
              <p>还没有导入任何词典。放入 zip 或 mdx 后点「重新扫描目录」。</p>
            </div>
          ) : (
            <table className="dict-table" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th style={{ width: 62 }}>启用</th>
                  <th>词典</th>
                  <th style={{ width: 60 }}>类型</th>
                  <th style={{ width: 84 }} className="num">
                    条目
                  </th>
                  <th style={{ width: 60 }} className="num">
                    优先级
                  </th>
                  <th style={{ width: 96 }} />
                </tr>
              </thead>
              <tbody>
                {sorted.map((d) => (
                  <tr key={d.id} className={d.enabled ? undefined : 'off'}>
                    <td>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={d.enabled}
                          disabled={busy}
                          onChange={(e) => patch(d.id, { enabled: e.target.checked })}
                          aria-label={`启用 ${d.title}`}
                        />
                      </label>
                    </td>
                    <td>
                      <div className="title">
                        {d.title}{' '}
                        <span className="chiptag" title={d.source === 'mdict' ? 'MDict 原生词典' : 'Yomitan 词典'}>
                          {d.source === 'mdict' ? 'MDict' : 'Yomitan'}
                        </span>
                        {d.hasStyle ? <span className="chiptag">CSS</span> : null}
                      </div>
                      <div className="sub">
                        {[d.revision && `版本 ${d.revision}`, d.author && `作者 ${d.author}`, d.fileName]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                      {d.url ? (
                        <div className="sub">
                          <a href={d.url} target="_blank" rel="noreferrer">
                            {d.url}
                          </a>
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <span className="chiptag">{KIND_LABEL[d.kind] ?? d.kind}</span>
                    </td>
                    <td className="num">
                      {(d.termCount || d.kanjiCount || d.metaCount || 0).toLocaleString()}
                    </td>
                    <td className="num">{d.priority}</td>
                    <td>
                      <div className="acts">
                        <button
                          className="btn icon ghost"
                          type="button"
                          title="提高优先级"
                          disabled={busy}
                          onClick={() => move(d, 1)}
                        >
                          <IconArrowUp />
                        </button>
                        <button
                          className="btn icon ghost"
                          type="button"
                          title="降低优先级"
                          disabled={busy}
                          onClick={() => move(d, -1)}
                        >
                          <IconArrowDown />
                        </button>
                        {confirmId === d.id ? (
                          <button className="btn sm danger" type="button" disabled={busy} onClick={() => remove(d.id)}>
                            确认删除
                          </button>
                        ) : (
                          <button
                            className="btn icon danger"
                            type="button"
                            title="删除词典"
                            disabled={busy}
                            onClick={() => setConfirmId(d.id)}
                          >
                            <IconTrash />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
