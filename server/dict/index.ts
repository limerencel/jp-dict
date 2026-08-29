/**
 * 词典模块对外入口。
 *
 * 典型用法：服务启动时 `await initDictionaries()`，之后所有查询都是同步的。
 * 数据落在 DATA_DIR/dictionaries.db，词典 zip 放进 DICT_DIR 即可被自动发现。
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  DictEntry,
  DictionaryMeta,
  FrequencyInfo,
  ImportProgress,
  KanjiEntry,
  PitchAccent,
} from '../../shared/types.ts';
import { MEDIA_DIR, ensureDirs } from '../config.ts';
import { closeDb, colNum, deleteDictionaryContent, getDb, transact } from './db.ts';
import { importDictionaryPath, scanDirectory } from './importer.ts';
import { removeMedia } from './media.ts';
import {
  getDictionary,
  getDictionaryStyle as getDictionaryStyleImpl,
  invalidateCaches,
  listDictionaries as listFromDb,
  lookupFrequency as lookupFrequencyImpl,
  lookupKanji as lookupKanjiImpl,
  lookupPitch as lookupPitchImpl,
  lookupTerm as lookupTermImpl,
  lookupTermsBatch as lookupTermsBatchImpl,
} from './query.ts';

/** 打开/建库 + 扫描 DICT_DIR 自动导入新词典。服务启动时调用一次。 */
export async function initDictionaries(onProgress?: (p: ImportProgress) => void): Promise<DictionaryMeta[]> {
  ensureDirs();
  getDb();
  await scanDirectory(onProgress);
  invalidateCaches();
  return listFromDb();
}

/** 已导入的词典列表（按 priority desc, id asc） */
export function listDictionaries(): DictionaryMeta[] {
  return listFromDb();
}

/** 是否至少有一部可用词典（启用且有词条或汉字内容） */
export function isReady(): boolean {
  return listFromDb().some((d) => d.enabled && (d.termCount > 0 || d.kanjiCount > 0));
}

/** 重新扫描目录并导入新增/变更的词典 */
export async function scanAndImport(
  onProgress?: (p: ImportProgress) => void,
): Promise<{ imported: DictionaryMeta[]; skipped: string[]; failed: { file: string; error: string }[] }> {
  const result = await scanDirectory(onProgress);
  invalidateCaches();
  return result;
}

/**
 * 导入单个词典文件（绝对路径），支持 Yomitan zip、MDict .mdx、以及内含 .mdx 的 zip。
 * 同名文件或同标题的旧版本会被就地替换，id 保持不变。
 */
export async function importDictionaryFile(
  absPath: string,
  onProgress?: (p: ImportProgress) => void,
): Promise<DictionaryMeta> {
  try {
    return await importDictionaryPath(path.resolve(absPath), onProgress);
  } finally {
    invalidateCaches();
  }
}

export function setDictionaryEnabled(id: number, enabled: boolean): DictionaryMeta | null {
  const conn = getDb();
  const info = conn.prepare('UPDATE dictionaries SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  invalidateCaches();
  return Number(info.changes) > 0 ? getDictionary(id) : null;
}

export function setDictionaryPriority(id: number, priority: number): DictionaryMeta | null {
  const conn = getDb();
  const info = conn.prepare('UPDATE dictionaries SET priority = ? WHERE id = ?').run(Math.trunc(priority), id);
  invalidateCaches();
  return Number(info.changes) > 0 ? getDictionary(id) : null;
}

export function deleteDictionary(id: number): boolean {
  const conn = getDb();
  const row = conn.prepare('SELECT id FROM dictionaries WHERE id = ?').get(id);
  if (!row) return false;
  const dictId = colNum(row.id);
  transact(conn, () => {
    deleteDictionaryContent(conn, dictId);
    conn.prepare('DELETE FROM dictionaries WHERE id = ?').run(dictId);
  });
  removeMedia(dictId);
  invalidateCaches();
  return true;
}

/**
 * 查词。只在 enabled 的词典里查。
 * term 会做 kana 归一化后同时匹配 expression_norm 与 reading_norm。
 * reading 给出时用于过滤同形异读（如 生：なま / せい）。
 */
export function lookupTerm(term: string, reading?: string, limit?: number): DictEntry[] {
  return lookupTermImpl(term, reading, limit);
}

/** 批量查询，key 为 `${term}\u0000${reading ?? ''}`，用于长文本分析时减少往返 */
export function lookupTermsBatch(
  queries: { term: string; reading?: string }[],
  limitPerQuery?: number,
): Map<string, DictEntry[]> {
  return lookupTermsBatchImpl(queries, limitPerQuery);
}

export function lookupKanji(characters: string[]): KanjiEntry[] {
  return lookupKanjiImpl(characters);
}

export function lookupPitch(term: string, reading?: string): PitchAccent[] {
  return lookupPitchImpl(term, reading);
}

export function lookupFrequency(term: string, reading?: string): FrequencyInfo[] {
  return lookupFrequencyImpl(term, reading);
}

/**
 * 词典自带的样式表（目前只有 MDict 词典有）。
 * 所有选择器已被作用域化到 `.mdx-dict-<id>`，可直接注入页面。
 */
export function getDictionaryStyle(id: number): string | null {
  return getDictionaryStyleImpl(id);
}

/** 媒体文件的绝对路径，供 HTTP 层做静态服务；越界或不存在时返回 null */
export function resolveMediaPath(dictId: number, relPath: string): string | null {
  if (!Number.isInteger(dictId) || dictId <= 0 || !relPath) return null;
  const root = path.join(MEDIA_DIR, String(dictId));
  const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned) return null;
  const dest = path.resolve(root, cleaned);
  // 防目录穿越：解析后必须仍落在该词典自己的媒体目录里
  if (dest !== root && !dest.startsWith(root + path.sep)) return null;
  try {
    return fs.statSync(dest).isFile() ? dest : null;
  } catch {
    return null;
  }
}

export function closeDictionaries(): void {
  invalidateCaches();
  closeDb();
}
