/**
 * 词典导入总控：识别来源形态（Yomitan zip / MDict mdx / 含 mdx 的 zip）→ 写库。
 *
 * 内存策略：zip 条目按需逐个解压，每处理完一个 bank 立刻释放；
 * MDict 逐 record block 解压。写库一律按批提交，单批 BATCH_ROWS 行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DictionaryKind, DictionaryMeta, DictionarySource, ImportProgress, TagInfo } from '../../shared/types.ts';
import { DATA_DIR, DICT_DIR, ensureDirs } from '../config.ts';
import {
  beginBulkMode,
  colNum,
  colText,
  deleteDictionaryContent,
  endBulkMode,
  getDb,
  refreshStatistics,
  transact,
} from './db.ts';
import { normalizeKey } from './kana.ts';
import { removeMedia, writeMedia } from './media.ts';
import { DICT_COLUMNS, rowToMeta } from './meta.ts';
import { parseIndex, parseKanjiRow, parseMetaRow, parseTagRow, parseTermRow } from './parse.ts';
import type { DictIndexInfo } from './parse.ts';
import { ZipReader } from './zip.ts';
import type { ZipEntry } from './zip.ts';
import { fillFromMdict, readMdictDescriptor } from './mdict/import.ts';
import type { MdictBundle } from './mdict/import.ts';

export type ProgressFn = (p: ImportProgress) => void;

const BATCH_ROWS = 20000;
/** 递归发现词典时的最大目录深度 */
const MAX_SCAN_DEPTH = 4;
/** zip 内的 mdx 需要先落盘才能随机读取 */
const TMP_DIR = path.join(DATA_DIR, '.import-tmp');

const BANK_PATTERNS: { kind: BankKind; re: RegExp }[] = [
  { kind: 'tag', re: /^tag_bank_(\d+)\.json$/i },
  { kind: 'term', re: /^term_bank_(\d+)\.json$/i },
  { kind: 'term_meta', re: /^term_meta_bank_(\d+)\.json$/i },
  { kind: 'kanji', re: /^kanji_bank_(\d+)\.json$/i },
  { kind: 'kanji_meta', re: /^kanji_meta_bank_(\d+)\.json$/i },
];

type BankKind = 'tag' | 'term' | 'term_meta' | 'kanji' | 'kanji_meta';

/** tag 必须先入库（查询期靠它解释标签），其余顺序只影响进度观感 */
const BANK_ORDER: BankKind[] = ['tag', 'term', 'term_meta', 'kanji', 'kanji_meta'];

interface ZipLayout {
  index: DictIndexInfo;
  banks: { kind: BankKind; order: number; entry: ZipEntry }[];
  media: { relPath: string; entry: ZipEntry }[];
}

interface Counters {
  terms: number;
  kanji: number;
  meta: number;
  freq: number;
  pitch: number;
  ipa: number;
  kanjiMeta: number;
  tags: number;
}

function emptyCounters(): Counters {
  return { terms: 0, kanji: 0, meta: 0, freq: 0, pitch: 0, ipa: 0, kanjiMeta: 0, tags: 0 };
}

/** 写进 dictionaries 行的元信息，两种来源统一成这个形状 */
interface DictDescriptor {
  title: string;
  revision: string;
  format: number;
  author?: string;
  url?: string;
  description?: string;
  attribution?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  frequencyMode?: 'occurrence-based' | 'rank-based';
  source: DictionarySource;
}

export interface FileFingerprint {
  /** 相对 DICT_DIR 的路径（用 / 分隔），作为词典的文件身份 */
  fileName: string;
  fileSize: number;
  mtimeMs: number;
  /** 全部相关文件的 size:mtime 签名，用于免开箱的快速跳过 */
  statSig: string;
}

export function fingerprintOf(fp: FileFingerprint, revision: string): string {
  return `${fp.fileName}|${fp.statSig}|${revision}`;
}

function emit(onProgress: ProgressFn | undefined, p: ImportProgress): void {
  onProgress?.(p);
}

function statSignature(files: string[]): string {
  return files
    .map((f) => {
      try {
        const s = fs.statSync(f);
        return `${path.basename(f)}:${s.size}:${Math.round(s.mtimeMs)}`;
      } catch {
        return `${path.basename(f)}:missing`;
      }
    })
    .join(';');
}

/* ────────────────────────── 词典来源发现 ────────────────────────── */

export interface DictCandidate {
  /** 相对 DICT_DIR 的路径 */
  relPath: string;
  absPath: string;
  kind: 'zip' | 'mdx';
  /** kind==='mdx' 时的配套文件 */
  bundle?: MdictBundle;
  /** 参与指纹计算的全部文件 */
  files: string[];
}

/** 同目录下按基名配对 .css / .mdd（含 xxx.1.mdd 这种分卷） */
function pairMdictCompanions(dir: string, mdxPath: string, names: string[]): MdictBundle {
  const base = path.basename(mdxPath).replace(/\.mdx$/i, '');
  const lowerBase = base.toLowerCase();
  const mddPaths: string[] = [];
  let cssPath: string | null = null;
  const cssCandidates: string[] = [];

  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.mdd')) {
      const stem = name.slice(0, -4).replace(/\.\d+$/, '').toLowerCase();
      if (stem === lowerBase) mddPaths.push(path.join(dir, name));
    } else if (lower.endsWith('.css')) {
      cssCandidates.push(name);
      if (lower === `${lowerBase}.css`) cssPath = path.join(dir, name);
    }
  }
  // 同名 css 不存在时，目录里唯一的那个 css 就是它（明镜就是 mjrhsjcd.css）
  if (!cssPath && cssCandidates.length === 1) cssPath = path.join(dir, cssCandidates[0]);
  mddPaths.sort((a, b) => a.localeCompare(b));
  return { mdxPath, cssPath, mddPaths };
}

export function discoverCandidates(root: string): DictCandidate[] {
  const out: DictCandidate[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    names.sort((a, b) => a.localeCompare(b));
    const subDirs: string[] = [];
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const abs = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        subDirs.push(abs);
        continue;
      }
      const lower = name.toLowerCase();
      const relPath = path.relative(root, abs).split(path.sep).join('/');
      if (lower.endsWith('.zip')) {
        out.push({ relPath, absPath: abs, kind: 'zip', files: [abs] });
      } else if (lower.endsWith('.mdx')) {
        const bundle = pairMdictCompanions(dir, abs, names);
        const files = [abs, ...(bundle.cssPath ? [bundle.cssPath] : []), ...bundle.mddPaths];
        out.push({ relPath, absPath: abs, kind: 'mdx', bundle, files });
      }
    }
    if (depth < MAX_SCAN_DEPTH) for (const sub of subDirs) walk(sub, depth + 1);
  };
  walk(root, 0);
  return out;
}

/* ────────────────────────── 打开来源 ────────────────────────── */

type Prepared =
  | { kind: 'yomitan'; descriptor: DictDescriptor; zip: ZipReader; layout: ZipLayout }
  | { kind: 'mdict'; descriptor: DictDescriptor; bundle: MdictBundle };

interface OpenedSource {
  prepared: Prepared;
  cleanup: () => Promise<void>;
}

function toDescriptor(index: DictIndexInfo): DictDescriptor {
  const d: DictDescriptor = {
    title: index.title,
    revision: index.revision,
    format: index.format,
    source: 'yomitan',
  };
  if (index.author) d.author = index.author;
  if (index.url) d.url = index.url;
  if (index.description) d.description = index.description;
  if (index.attribution) d.attribution = index.attribution;
  if (index.sourceLanguage) d.sourceLanguage = index.sourceLanguage;
  if (index.targetLanguage) d.targetLanguage = index.targetLanguage;
  if (index.frequencyMode) d.frequencyMode = index.frequencyMode;
  return d;
}

/** 把 zip 里的 mdx/mdd/css 解到临时目录，返回可直接读的 bundle */
async function extractMdictFromZip(zip: ZipReader, entries: ZipEntry[], mdxEntry: ZipEntry): Promise<{ bundle: MdictBundle; tmp: string }> {
  const tmp = path.join(TMP_DIR, randomUUID());
  fs.mkdirSync(tmp, { recursive: true });
  const dump = async (entry: ZipEntry): Promise<string> => {
    const dest = path.join(tmp, path.basename(entry.name));
    fs.writeFileSync(dest, await zip.read(entry));
    return dest;
  };
  const mdxPath = await dump(mdxEntry);
  const dir = mdxEntry.name.slice(0, mdxEntry.name.lastIndexOf('/') + 1);
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory || entry === mdxEntry) continue;
    if (!entry.name.startsWith(dir)) continue;
    const rest = entry.name.slice(dir.length);
    if (rest.includes('/')) continue;
    if (!/\.(css|mdd)$/i.test(rest)) continue;
    await dump(entry);
    names.push(path.basename(rest));
  }
  names.push(path.basename(mdxPath));
  return { bundle: pairMdictCompanions(tmp, mdxPath, names), tmp };
}

async function openCandidate(candidate: DictCandidate): Promise<OpenedSource> {
  if (candidate.kind === 'mdx') {
    const bundle = candidate.bundle!;
    const info = await readMdictDescriptor(bundle.mdxPath);
    return {
      prepared: { kind: 'mdict', descriptor: { ...info, source: 'mdict' }, bundle },
      cleanup: async () => {},
    };
  }

  const zip = await ZipReader.open(candidate.absPath);
  try {
    const hasIndex = zip.entries.some((e) => !e.isDirectory && /(^|\/)index\.json$/i.test(e.name));
    if (hasIndex) {
      const layout = await readLayout(zip, path.basename(candidate.absPath).replace(/\.zip$/i, ''));
      return {
        prepared: { kind: 'yomitan', descriptor: toDescriptor(layout.index), zip, layout },
        cleanup: async () => {
          await zip.close();
        },
      };
    }

    // 没有 index.json，看看是不是打包好的 MDict 词典
    let mdxEntry: ZipEntry | null = null;
    for (const entry of zip.entries) {
      if (entry.isDirectory || !/\.mdx$/i.test(entry.name)) continue;
      if (!mdxEntry || entry.name.length < mdxEntry.name.length) mdxEntry = entry;
    }
    if (!mdxEntry) throw new Error('zip 内既没有 index.json 也没有 .mdx，无法识别为词典');

    const { bundle, tmp } = await extractMdictFromZip(zip, zip.entries, mdxEntry);
    await zip.close();
    try {
      const info = await readMdictDescriptor(bundle.mdxPath);
      return {
        prepared: { kind: 'mdict', descriptor: { ...info, source: 'mdict' }, bundle },
        cleanup: async () => {
          fs.rmSync(tmp, { recursive: true, force: true });
        },
      };
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
  } catch (err) {
    await zip.close().catch(() => {});
    throw err;
  }
}

/* ────────────────────────── Yomitan zip 布局 ────────────────────────── */

async function readLayout(zip: ZipReader, fallbackTitle: string): Promise<ZipLayout> {
  // 规范要求 index.json 在根目录，但不少词典多包了一层文件夹，这里取路径最浅的那个当根
  let indexEntry: ZipEntry | null = null;
  for (const entry of zip.entries) {
    if (entry.isDirectory) continue;
    if (!/(^|\/)index\.json$/i.test(entry.name)) continue;
    if (!indexEntry || entry.name.length < indexEntry.name.length) indexEntry = entry;
  }
  if (!indexEntry) throw new Error('zip 内找不到 index.json，不是 Yomitan 词典');

  const prefix = indexEntry.name.slice(0, indexEntry.name.length - 'index.json'.length);
  let indexRaw: unknown;
  try {
    indexRaw = JSON.parse(await zip.readText(indexEntry));
  } catch (err) {
    throw new Error(`index.json 解析失败: ${(err as Error).message}`);
  }
  const index = parseIndex(indexRaw, fallbackTitle);

  const banks: ZipLayout['banks'] = [];
  const media: ZipLayout['media'] = [];
  for (const entry of zip.entries) {
    if (entry.isDirectory || entry === indexEntry) continue;
    if (prefix && !entry.name.startsWith(prefix)) continue;
    const relPath = entry.name.slice(prefix.length);
    if (!relPath || relPath.includes('..')) continue;
    const base = relPath.slice(relPath.lastIndexOf('/') + 1);
    const matched = BANK_PATTERNS.find((p) => p.re.test(base) && !relPath.includes('/'));
    if (matched) {
      banks.push({ kind: matched.kind, order: Number(matched.re.exec(base)![1]), entry });
    } else if (!/^index\.json$/i.test(relPath)) {
      media.push({ relPath, entry });
    }
  }

  banks.sort((a, b) => BANK_ORDER.indexOf(a.kind) - BANK_ORDER.indexOf(b.kind) || a.order - b.order);
  return { index, banks, media };
}

/* ────────────────────────── 词典行写入 ────────────────────────── */

/**
 * 写入词典行。reuseId 非空时原地更新——重导入必须保持 id 不变，
 * 否则前端/配置里存的词典 id 会全部失效。
 */
function upsertDictionaryRow(
  conn: DatabaseSync,
  d: DictDescriptor,
  file: FileFingerprint,
  keep: { enabled: number; priority: number },
  reuseId: number | null,
): number {
  const columns = `title = ?, revision = ?, format = ?, author = ?, url = ?, description = ?, attribution = ?,
     source_language = ?, target_language = ?, frequency_mode = ?, kind = 'term',
     term_count = 0, kanji_count = 0, meta_count = 0, enabled = ?, priority = ?,
     file_name = ?, file_size = ?, file_mtime = ?, fingerprint = ?, imported_at = ?, source = ?, css = ''`;
  const stmt = conn.prepare(
    reuseId === null
      ? `INSERT INTO dictionaries
         (title, revision, format, author, url, description, attribution, source_language, target_language,
          frequency_mode, kind, term_count, kanji_count, meta_count, enabled, priority,
          file_name, file_size, file_mtime, fingerprint, imported_at, source, css)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'term', 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, '')`
      : `UPDATE dictionaries SET ${columns} WHERE id = ${reuseId}`,
  );
  const info = stmt.run(
    d.title,
    d.revision,
    d.format,
    d.author ?? '',
    d.url ?? '',
    d.description ?? '',
    d.attribution ?? '',
    d.sourceLanguage ?? '',
    d.targetLanguage ?? '',
    d.frequencyMode ?? '',
    keep.enabled,
    keep.priority,
    file.fileName,
    file.fileSize,
    file.mtimeMs,
    fingerprintOf(file, d.revision),
    new Date().toISOString(),
    d.source,
  );
  return reuseId === null ? Number(info.lastInsertRowid) : reuseId;
}

function prepareTagInsert(conn: DatabaseSync) {
  return conn.prepare(
    'INSERT INTO tags (dict_id, name, category, ord, notes, score) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(dict_id, name) DO UPDATE SET category = excluded.category, ord = excluded.ord, ' +
      'notes = excluded.notes, score = excluded.score',
  );
}

function insertTags(conn: DatabaseSync, dictId: number, tags: TagInfo[]): number {
  if (!tags.length) return 0;
  const stmt = prepareTagInsert(conn);
  let n = 0;
  for (const tag of tags) {
    stmt.run(dictId, tag.name, tag.category, tag.order, tag.notes, tag.score);
    n++;
  }
  return n;
}

/** 按批写入：单个 bank 行数过多时切成多个事务，避免事务日志无限膨胀 */
function writeRows<T>(conn: DatabaseSync, rows: T[], write: (row: T) => void): void {
  let i = 0;
  while (i < rows.length) {
    const end = Math.min(i + BATCH_ROWS, rows.length);
    transact(conn, () => {
      for (let j = i; j < end; j++) write(rows[j]);
    });
    i = end;
  }
}

function parseBank(text: string, file: string): unknown[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} 解析失败: ${(err as Error).message}`);
  }
  return Array.isArray(data) ? data : [];
}

function inferKind(c: Counters): DictionaryKind {
  const hasTerm = c.terms > 0;
  const hasKanji = c.kanji > 0 || c.kanjiMeta > 0;
  const hasFreq = c.freq > 0;
  const hasPitch = c.pitch > 0;
  const groups = [hasTerm, hasKanji, hasFreq, hasPitch].filter(Boolean).length;
  if (groups > 1) return 'mixed';
  if (hasTerm) return 'term';
  if (hasKanji) return 'kanji';
  if (hasFreq) return 'frequency';
  if (hasPitch) return 'pitch';
  return c.ipa > 0 ? 'mixed' : 'term';
}

/* ────────────────────────── 导入主流程 ────────────────────────── */

function fingerprintFor(candidate: DictCandidate): FileFingerprint {
  const stat = fs.statSync(candidate.absPath);
  return {
    fileName: candidate.relPath,
    fileSize: stat.size,
    mtimeMs: stat.mtimeMs,
    statSig: statSignature(candidate.files),
  };
}

/** 把绝对路径变成候选项；DICT_DIR 之外的文件用文件名作身份 */
function candidateFromPath(absPath: string): DictCandidate {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    throw new Error(`词典文件不存在: ${absPath}`);
  }
  if (!stat.isFile()) throw new Error(`不是文件: ${absPath}`);

  const rel = path.relative(DICT_DIR, absPath);
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  const relPath = inside ? rel.split(path.sep).join('/') : path.basename(absPath);
  const lower = absPath.toLowerCase();
  if (lower.endsWith('.mdx')) {
    const dir = path.dirname(absPath);
    const bundle = pairMdictCompanions(dir, absPath, fs.readdirSync(dir));
    return {
      relPath,
      absPath,
      kind: 'mdx',
      bundle,
      files: [absPath, ...(bundle.cssPath ? [bundle.cssPath] : []), ...bundle.mddPaths],
    };
  }
  if (lower.endsWith('.zip')) return { relPath, absPath, kind: 'zip', files: [absPath] };
  throw new Error(`不支持的词典文件类型（只认 .zip 与 .mdx）: ${path.basename(absPath)}`);
}

export async function importDictionaryPath(absPath: string, onProgress?: ProgressFn): Promise<DictionaryMeta> {
  ensureDirs();
  const conn = getDb();
  const candidate = candidateFromPath(absPath);
  emit(onProgress, { phase: 'read', file: candidate.relPath, message: '读取词典文件', progress: 0 });
  const opened = await openCandidate(candidate);
  try {
    return await runImport(conn, opened.prepared, fingerprintFor(candidate), onProgress);
  } finally {
    await opened.cleanup();
  }
}

async function runImport(
  conn: DatabaseSync,
  prepared: Prepared,
  file: FileFingerprint,
  onProgress?: ProgressFn,
): Promise<DictionaryMeta> {
  const { descriptor } = prepared;
  const label = file.fileName;

  // 同名文件或同标题的旧版本先清空内容，保证导入幂等；
  // 其中一行原地复用（保留 id / enabled / priority），多余的行删掉
  const stale = conn
    .prepare('SELECT id, enabled, priority, file_name FROM dictionaries WHERE file_name = ? OR title = ? ORDER BY id')
    .all(file.fileName, descriptor.title);
  const primary = stale.find((row) => colText(row.file_name) === file.fileName) ?? stale[0];
  const reuseId = primary ? colNum(primary.id) : null;
  const keep = {
    enabled: primary ? colNum(primary.enabled) : 1,
    priority: primary ? colNum(primary.priority) : 0,
  };
  for (const row of stale) {
    const id = colNum(row.id);
    transact(conn, () => {
      deleteDictionaryContent(conn, id);
      if (id !== reuseId) conn.prepare('DELETE FROM dictionaries WHERE id = ?').run(id);
    });
    removeMedia(id);
  }

  const dictId = transact(conn, () => upsertDictionaryRow(conn, descriptor, file, keep, reuseId));
  const counters = emptyCounters();
  let extraSummary = '';

  beginBulkMode(conn);
  try {
    if (prepared.kind === 'yomitan') {
      await fillFromYomitan(conn, dictId, prepared.zip, prepared.layout, counters, label, onProgress);
    } else {
      const result = await fillFromMdict(conn, dictId, prepared.bundle, label, onProgress);
      counters.terms = result.rows;
      extraSummary = `（真词条 ${result.real} / 别名 ${result.rows - result.real}${
        result.media ? ` / 资源 ${result.media}` : ''
      }）`;
    }

    emit(onProgress, { phase: 'index', file: label, message: '更新统计与索引', progress: 1 });
    transact(conn, () => {
      conn
        .prepare('UPDATE dictionaries SET term_count = ?, kanji_count = ?, meta_count = ?, kind = ? WHERE id = ?')
        .run(counters.terms, counters.kanji, counters.meta, inferKind(counters), dictId);
    });
    refreshStatistics(conn);
  } catch (err) {
    // 半成品词典留在库里只会污染查询结果
    try {
      transact(conn, () => {
        deleteDictionaryContent(conn, dictId);
        conn.prepare('DELETE FROM dictionaries WHERE id = ?').run(dictId);
      });
      removeMedia(dictId);
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw err;
  } finally {
    endBulkMode(conn);
  }

  const row = conn.prepare(`SELECT ${DICT_COLUMNS} FROM dictionaries WHERE id = ?`).get(dictId);
  if (!row) throw new Error('导入后读不到词典记录');
  const meta = rowToMeta(row);
  emit(onProgress, {
    phase: 'done',
    file: label,
    message:
      meta.source === 'mdict'
        ? `${meta.title}：词条 ${meta.termCount} ${extraSummary}`
        : `${meta.title}：词条 ${meta.termCount} / 汉字 ${meta.kanjiCount} / 元数据 ${meta.metaCount}`,
    progress: 1,
  });
  return meta;
}

async function fillFromYomitan(
  conn: DatabaseSync,
  dictId: number,
  zip: ZipReader,
  layout: ZipLayout,
  counters: Counters,
  label: string,
  onProgress?: ProgressFn,
): Promise<void> {
  counters.tags += transact(conn, () => insertTags(conn, dictId, layout.index.tagMeta));

  const total = layout.banks.length + (layout.media.length ? 1 : 0) || 1;
  let done = 0;
  for (const bank of layout.banks) {
    const base = bank.entry.name.slice(bank.entry.name.lastIndexOf('/') + 1);
    emit(onProgress, { phase: 'parse', file: label, message: `解析 ${base}`, progress: done / total });
    const rows = parseBank(await zip.readText(bank.entry), base);
    emit(onProgress, {
      phase: 'write',
      file: label,
      message: `写入 ${base}（${rows.length} 行）`,
      progress: done / total,
    });
    writeBank(conn, dictId, bank.kind, rows, counters);
    done++;
    emit(onProgress, { phase: 'write', file: label, message: `${base} 完成`, progress: done / total });
  }

  if (layout.media.length) {
    emit(onProgress, {
      phase: 'write',
      file: label,
      message: `解包媒体文件（${layout.media.length} 个）`,
      progress: done / total,
    });
    for (const item of layout.media) {
      writeMedia(dictId, item.relPath, await zip.read(item.entry));
    }
  }
}

function writeBank(conn: DatabaseSync, dictId: number, kind: BankKind, rows: unknown[], c: Counters): void {
  switch (kind) {
    case 'tag': {
      const stmt = prepareTagInsert(conn);
      writeRows(conn, rows, (raw) => {
        const tag = parseTagRow(raw);
        if (!tag) return;
        stmt.run(dictId, tag.name, tag.category, tag.order, tag.notes, tag.score);
        c.tags++;
      });
      return;
    }
    case 'term': {
      const stmt = conn.prepare(
        `INSERT INTO terms
         (dict_id, expression, reading, expression_norm, reading_norm, definition_tags, term_tags, rules, score, sequence, glossary_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      writeRows(conn, rows, (raw) => {
        const term = parseTermRow(raw);
        if (!term) return;
        stmt.run(
          dictId,
          term.expression,
          term.reading,
          normalizeKey(term.expression),
          normalizeKey(term.reading),
          term.definitionTags,
          term.termTags,
          term.rules,
          Math.trunc(term.score),
          Math.trunc(term.sequence),
          JSON.stringify(term.glossary),
        );
        c.terms++;
      });
      return;
    }
    case 'term_meta':
    case 'kanji_meta': {
      const stmt = conn.prepare(
        'INSERT INTO term_meta (dict_id, expression, expression_norm, mode, reading, reading_norm, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      const isKanjiMeta = kind === 'kanji_meta';
      writeRows(conn, rows, (raw) => {
        const meta = parseMetaRow(raw);
        if (!meta) return;
        // 汉字频率与词频共用一张表，靠 mode 区分，避免多建一张几乎不用的表
        const mode = isKanjiMeta && meta.mode === 'freq' ? 'kanji-freq' : meta.mode;
        stmt.run(
          dictId,
          meta.expression,
          normalizeKey(meta.expression),
          mode,
          meta.reading,
          normalizeKey(meta.reading),
          JSON.stringify(meta.data),
        );
        c.meta++;
        if (mode === 'kanji-freq') c.kanjiMeta++;
        else if (meta.mode === 'freq') c.freq++;
        else if (meta.mode === 'pitch') c.pitch++;
        else c.ipa++;
      });
      return;
    }
    case 'kanji': {
      const stmt = conn.prepare(
        'INSERT INTO kanji (dict_id, character, onyomi, kunyomi, tags, meanings_json, stats_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      writeRows(conn, rows, (raw) => {
        const kanji = parseKanjiRow(raw);
        if (!kanji) return;
        stmt.run(
          dictId,
          kanji.character,
          kanji.onyomi,
          kanji.kunyomi,
          kanji.tags,
          JSON.stringify(kanji.meanings),
          JSON.stringify(kanji.stats),
        );
        c.kanji++;
      });
      return;
    }
  }
}

/* ────────────────────────── 目录扫描 ────────────────────────── */

export interface ScanResult {
  imported: DictionaryMeta[];
  skipped: string[];
  failed: { file: string; error: string }[];
}

/** 'skip' 免开箱跳过；'check' 需要开箱比对版本；'import' 直接导入 */
function looksLikeLegacyZipMojibake(text: string): boolean {
  if (/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u.test(text)) return false;
  return (text.match(/[\u0080-\u00ff]/gu)?.length ?? 0) >= 4;
}

function skipDecision(conn: DatabaseSync, file: FileFingerprint): 'skip' | 'check' | 'import' {
  const row = conn.prepare('SELECT fingerprint, title FROM dictionaries WHERE file_name = ?').get(file.fileName);
  if (!row) return 'import';
  // 旧版曾把未标 UTF-8 的中文 ZIP 文件名按 Latin-1 解码；即使源文件未变，也要开箱修正一次标题。
  if (looksLikeLegacyZipMojibake(colText(row.title))) return 'check';
  const stored = colText(row.fingerprint);
  // fingerprint 形如 name|statSig|revision，前两段能对上就说明文件没动过
  return stored.startsWith(`${file.fileName}|${file.statSig}|`) ? 'skip' : 'check';
}

export async function scanDirectory(onProgress?: ProgressFn): Promise<ScanResult> {
  ensureDirs();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  const conn = getDb();
  const result: ScanResult = { imported: [], skipped: [], failed: [] };

  let candidates: DictCandidate[];
  try {
    candidates = discoverCandidates(DICT_DIR);
  } catch (err) {
    emit(onProgress, {
      phase: 'error',
      file: DICT_DIR,
      message: `无法读取词典目录: ${(err as Error).message}`,
      progress: -1,
    });
    return result;
  }

  emit(onProgress, {
    phase: 'scan',
    file: DICT_DIR,
    message: `发现 ${candidates.length} 个词典文件`,
    progress: candidates.length ? 0 : 1,
  });

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const done = (i + 1) / candidates.length;
    try {
      const file = fingerprintFor(candidate);
      if (skipDecision(conn, file) === 'skip') {
        result.skipped.push(candidate.relPath);
        emit(onProgress, { phase: 'scan', file: candidate.relPath, message: '已是最新，跳过', progress: done });
        continue;
      }

      const opened = await openCandidate(candidate);
      try {
        const { title, revision } = opened.prepared.descriptor;
        const row = conn.prepare('SELECT id, fingerprint, title FROM dictionaries WHERE file_name = ?').get(file.fileName);
        if (row && colText(row.fingerprint) === fingerprintOf(file, revision)) {
          const storedTitle = colText(row.title);
          if (storedTitle !== title && looksLikeLegacyZipMojibake(storedTitle)) {
            conn.prepare('UPDATE dictionaries SET title = ? WHERE id = ?').run(title, colNum(row.id));
            result.skipped.push(candidate.relPath);
            emit(onProgress, { phase: 'scan', file: candidate.relPath, message: `已修正标题编码为《${title}》`, progress: done });
            continue;
          }
          result.skipped.push(candidate.relPath);
          emit(onProgress, { phase: 'scan', file: candidate.relPath, message: '版本未变，跳过', progress: done });
          continue;
        }

        // 同一部词典同时以 zip 和解压目录两种形态存在时，只认先扫到的那个，
        // 否则两者会在每次扫描里互相顶替，反复重导
        if (!row) {
          const twin = conn
            .prepare('SELECT file_name FROM dictionaries WHERE title = ? AND file_name <> ?')
            .get(title, file.fileName);
          const twinFile = twin ? colText(twin.file_name) : '';
          if (twinFile && fs.existsSync(path.join(DICT_DIR, twinFile))) {
            result.skipped.push(candidate.relPath);
            emit(onProgress, {
              phase: 'scan',
              file: candidate.relPath,
              message: `与已导入的《${title}》（${twinFile}）重复，跳过`,
              progress: done,
            });
            continue;
          }
        }

        result.imported.push(await runImport(conn, opened.prepared, file, onProgress));
      } finally {
        await opened.cleanup();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed.push({ file: candidate.relPath, error: message });
      emit(onProgress, { phase: 'error', file: candidate.relPath, message: `导入失败: ${message}`, progress: -1 });
    }
  }

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  emit(onProgress, {
    phase: 'done',
    file: DICT_DIR,
    message: `导入 ${result.imported.length}，跳过 ${result.skipped.length}，失败 ${result.failed.length}`,
    progress: 1,
  });
  return result;
}
