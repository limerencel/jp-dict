/**
 * SQLite 连接与表结构。
 * 用 node:sqlite 的 DatabaseSync（同步 API），所有写入都包在显式事务里。
 */
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import { DB_PATH, ensureDirs } from '../config.ts';

/**
 * 表结构版本：变更后旧库整体重建（词典可从源文件重新导入，无保留价值）。
 * v2：新增 MDict 支持——dictionaries.source / dictionaries.css / terms.alias_of。
 */
export const SCHEMA_VERSION = 2;

export type Row = Record<string, SQLOutputValue>;

const DDL = `
CREATE TABLE IF NOT EXISTS dictionaries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT    NOT NULL,
  revision        TEXT    NOT NULL DEFAULT '',
  format          INTEGER NOT NULL DEFAULT 3,
  author          TEXT    NOT NULL DEFAULT '',
  url             TEXT    NOT NULL DEFAULT '',
  description     TEXT    NOT NULL DEFAULT '',
  attribution     TEXT    NOT NULL DEFAULT '',
  source_language TEXT    NOT NULL DEFAULT '',
  target_language TEXT    NOT NULL DEFAULT '',
  frequency_mode  TEXT    NOT NULL DEFAULT '',
  kind            TEXT    NOT NULL DEFAULT 'term',
  term_count      INTEGER NOT NULL DEFAULT 0,
  kanji_count     INTEGER NOT NULL DEFAULT 0,
  meta_count      INTEGER NOT NULL DEFAULT 0,
  enabled         INTEGER NOT NULL DEFAULT 1,
  priority        INTEGER NOT NULL DEFAULT 0,
  file_name       TEXT    NOT NULL,
  file_size       INTEGER NOT NULL DEFAULT 0,
  file_mtime      REAL    NOT NULL DEFAULT 0,
  fingerprint     TEXT    NOT NULL DEFAULT '',
  imported_at     TEXT    NOT NULL DEFAULT '',
  source          TEXT    NOT NULL DEFAULT 'yomitan',
  css             TEXT    NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dict_file ON dictionaries(file_name);

CREATE TABLE IF NOT EXISTS terms (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  dict_id         INTEGER NOT NULL,
  expression      TEXT    NOT NULL,
  reading         TEXT    NOT NULL DEFAULT '',
  expression_norm TEXT    NOT NULL,
  reading_norm    TEXT    NOT NULL DEFAULT '',
  definition_tags TEXT    NOT NULL DEFAULT '',
  term_tags       TEXT    NOT NULL DEFAULT '',
  rules           TEXT    NOT NULL DEFAULT '',
  score           INTEGER NOT NULL DEFAULT 0,
  sequence        INTEGER NOT NULL DEFAULT -1,
  glossary_json   TEXT    NOT NULL DEFAULT '[]',
  /** MDict 的 @@@LINK 重定向：指向真正持有释义的行，导入时已压平成单跳 */
  alias_of        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_terms_expr ON terms(expression_norm);
CREATE INDEX IF NOT EXISTS idx_terms_read ON terms(reading_norm);
CREATE INDEX IF NOT EXISTS idx_terms_dict ON terms(dict_id);

CREATE TABLE IF NOT EXISTS term_meta (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  dict_id         INTEGER NOT NULL,
  expression      TEXT    NOT NULL,
  expression_norm TEXT    NOT NULL,
  mode            TEXT    NOT NULL,
  reading         TEXT    NOT NULL DEFAULT '',
  reading_norm    TEXT    NOT NULL DEFAULT '',
  data_json       TEXT    NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_meta_expr_mode ON term_meta(expression_norm, mode);
CREATE INDEX IF NOT EXISTS idx_meta_dict ON term_meta(dict_id);

CREATE TABLE IF NOT EXISTS kanji (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  dict_id       INTEGER NOT NULL,
  character     TEXT    NOT NULL,
  onyomi        TEXT    NOT NULL DEFAULT '',
  kunyomi       TEXT    NOT NULL DEFAULT '',
  tags          TEXT    NOT NULL DEFAULT '',
  meanings_json TEXT    NOT NULL DEFAULT '[]',
  stats_json    TEXT    NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_kanji_char ON kanji(character);
CREATE INDEX IF NOT EXISTS idx_kanji_dict ON kanji(dict_id);

CREATE TABLE IF NOT EXISTS tags (
  dict_id  INTEGER NOT NULL,
  name     TEXT    NOT NULL,
  category TEXT    NOT NULL DEFAULT '',
  ord      INTEGER NOT NULL DEFAULT 0,
  notes    TEXT    NOT NULL DEFAULT '',
  score    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (dict_id, name)
) WITHOUT ROWID;
`;

const CONTENT_TABLES = ['terms', 'term_meta', 'kanji', 'tags'] as const;

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  ensureDirs();
  const conn = new DatabaseSync(DB_PATH);
  conn.exec('PRAGMA journal_mode = WAL');
  conn.exec('PRAGMA synchronous = NORMAL');
  conn.exec('PRAGMA temp_store = MEMORY');
  migrate(conn);
  db = conn;
  return conn;
}

export function closeDb(): void {
  if (!db) return;
  db.close();
  db = null;
}

/**
 * 刷新查询计划统计。
 * 必须在每次导入后调用：sqlite_stat1 若停留在「表里只有几行」的旧值，
 * 查询计划会退化成全表扫描（实测 20 万词条时单次查词从 <0.01ms 变成 170ms）。
 * analysis_limit 让 ANALYZE 只抽样，几十万行也在百毫秒级完成。
 */
export function refreshStatistics(conn: DatabaseSync): void {
  conn.exec('PRAGMA analysis_limit = 400');
  conn.exec('ANALYZE');
}

function migrate(conn: DatabaseSync): void {
  conn.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = conn.prepare('SELECT value FROM schema_meta WHERE key = ?').get('version');
  const current = row ? Number(row.value) : 0;
  if (current !== SCHEMA_VERSION) {
    for (const table of [...CONTENT_TABLES, 'dictionaries']) {
      conn.exec(`DROP TABLE IF EXISTS ${table}`);
    }
  }
  conn.exec(DDL);
  conn
    .prepare('INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('version', String(SCHEMA_VERSION));
}

/** 删除某部词典的全部内容行（不含 dictionaries 自身） */
export function deleteDictionaryContent(conn: DatabaseSync, dictId: number): void {
  for (const table of CONTENT_TABLES) {
    conn.prepare(`DELETE FROM ${table} WHERE dict_id = ?`).run(dictId);
  }
}

/** 导入期临时放宽落盘约束，换取吞吐 */
export function beginBulkMode(conn: DatabaseSync): void {
  conn.exec('PRAGMA synchronous = OFF');
  conn.exec('PRAGMA cache_size = -65536');
}

export function endBulkMode(conn: DatabaseSync): void {
  conn.exec('PRAGMA synchronous = NORMAL');
  conn.exec('PRAGMA cache_size = -8000');
}

export function transact<T>(conn: DatabaseSync, fn: () => T): T {
  conn.exec('BEGIN');
  try {
    const result = fn();
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      /* 事务已被 SQLite 自动回滚 */
    }
    throw err;
  }
}

/* ────────────────────────── 取值收窄 ────────────────────────── */

export function colText(v: SQLOutputValue): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'bigint') return String(v);
  return '';
}

export function colNum(v: SQLOutputValue): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function colJson<T>(v: SQLOutputValue, fallback: T): T {
  const text = colText(v);
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
