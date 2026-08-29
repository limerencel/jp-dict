/** dictionaries 行 ↔ DictionaryMeta */
import type { DictionaryKind, DictionaryMeta, DictionarySource } from '../../shared/types.ts';
import { colNum, colText } from './db.ts';
import type { Row } from './db.ts';

const KINDS = new Set<DictionaryKind>(['term', 'kanji', 'frequency', 'pitch', 'mixed']);

/**
 * 读取 DictionaryMeta 所需的列。
 * 刻意不用 `SELECT *`：css 列可能有几十 KB，列表接口不该每次都把它拉出来。
 */
export const DICT_COLUMNS = `id, title, revision, format, author, url, description, attribution,
  source_language, target_language, frequency_mode, kind, term_count, kanji_count, meta_count,
  enabled, priority, file_name, file_size, imported_at, source, length(css) > 0 AS has_style`;

export function rowToMeta(row: Row): DictionaryMeta {
  const kindText = colText(row.kind) as DictionaryKind;
  const sourceText = colText(row.source);
  const source: DictionarySource = sourceText === 'mdict' ? 'mdict' : 'yomitan';
  const meta: DictionaryMeta = {
    id: colNum(row.id),
    title: colText(row.title),
    revision: colText(row.revision),
    format: colNum(row.format),
    kind: KINDS.has(kindText) ? kindText : 'term',
    termCount: colNum(row.term_count),
    kanjiCount: colNum(row.kanji_count),
    metaCount: colNum(row.meta_count),
    enabled: colNum(row.enabled) !== 0,
    priority: colNum(row.priority),
    fileName: colText(row.file_name),
    fileSize: colNum(row.file_size),
    importedAt: colText(row.imported_at),
    source,
    hasStyle: colNum(row.has_style) !== 0,
  };
  // 可选字段留空时不出现在 JSON 里，前端好判断
  const author = colText(row.author);
  const url = colText(row.url);
  const description = colText(row.description);
  const attribution = colText(row.attribution);
  const sourceLanguage = colText(row.source_language);
  const targetLanguage = colText(row.target_language);
  const frequencyMode = colText(row.frequency_mode);
  if (author) meta.author = author;
  if (url) meta.url = url;
  if (description) meta.description = description;
  if (attribution) meta.attribution = attribution;
  if (sourceLanguage) meta.sourceLanguage = sourceLanguage;
  if (targetLanguage) meta.targetLanguage = targetLanguage;
  if (frequencyMode === 'occurrence-based' || frequencyMode === 'rank-based') meta.frequencyMode = frequencyMode;
  return meta;
}
