/**
 * MDict 词典 → SQLite。
 *
 * 别名方案：明镜这类词典里 80% 的键是 `@@@LINK=` 重定向（30.4 万键只有 6.1 万条真词条）。
 * 展开成副本会把库撑大一个数量级，所以别名行只存指向真词条行的 alias_of，
 * 释义留空，查询期再解引用。链在导入时用 SQL 反复压平成单跳，顺带断环。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ImportProgress } from '../../../shared/types.ts';
import { colNum } from '../db.ts';
import { normalizeKey } from '../kana.ts';
import { mediaUrlBase, writeMedia } from '../media.ts';
import { scopeCss } from './css.ts';
import { cleanMdictKey, looksLikeAlias, parseAliasTarget } from './entry.ts';
import { sanitizeEntryHtml } from './html.ts';
import { MdictFile, bufferSource, fileSource, unescapeXml } from './reader.ts';

/** 前端渲染 MDict 词条时套的容器类名 */
export function mdictScopeClass(dictId: number): string {
  return `.mdx-dict-${dictId}`;
}

const BATCH_ROWS = 20000;
/** 别名链压平的最大轮数，超过即判定为环 */
const MAX_ALIAS_HOPS = 8;

/** 一部 MDict 词典涉及的全部文件 */
export interface MdictBundle {
  /** .mdx 绝对路径；zip 内的词典会先解到临时目录 */
  mdxPath: string;
  cssPath: string | null;
  mddPaths: string[];
}

export interface MdictDescriptor {
  title: string;
  revision: string;
  format: number;
  description?: string;
  attribution?: string;
}

/** 只读头部，用于扫描阶段拿标题与指纹，不解析 key/record 区之外的内容 */
export async function readMdictDescriptor(mdxPath: string): Promise<MdictDescriptor> {
  const file = await MdictFile.open(await fileSource(mdxPath), false);
  try {
    return describe(file, mdxPath);
  } finally {
    await file.close();
  }
}

/** Title 常是 MdxBuilder 留下的占位符，这种情况回退到文件名 */
function describe(file: MdictFile, mdxPath: string): MdictDescriptor {
  const raw = file.header.raw;
  const title = raw.Title?.trim() ?? '';
  const placeholder = !title || /^title\b/i.test(title) || title.toLowerCase() === 'no html code allowed';
  const descriptor: MdictDescriptor = {
    title: placeholder ? path.basename(mdxPath).replace(/\.mdx$/i, '') : title,
    revision: [raw.CreationDate, raw.GeneratedByEngineVersion].filter(Boolean).join(' / '),
    format: Math.round(file.header.version * 10) / 10,
  };
  const description = unescapeXml(raw.Description ?? '').trim();
  if (description) descriptor.description = description;
  return descriptor;
}

interface Counts {
  /** 真词条（带 HTML 释义） */
  real: number;
  /** 别名行（含从【A・B】拆出的异形） */
  alias: number;
  /** 解引用失败被删掉的别名 */
  dangling: number;
  /** 与目标完全等价、被去重删掉的别名 */
  redundant: number;
  media: number;
}

export interface MdictImportResult extends Counts {
  /** 最终留在 terms 表里的行数 */
  rows: number;
  hasStyle: boolean;
}

type ProgressFn = (p: ImportProgress) => void;

/** 逐条插入但按批提交，避免单个巨型事务把 WAL 撑爆 */
class BatchWriter {
  private inTx = false;
  private pending = 0;
  private readonly conn: DatabaseSync;

  constructor(conn: DatabaseSync) {
    this.conn = conn;
  }

  tick(): void {
    if (!this.inTx) {
      this.conn.exec('BEGIN');
      this.inTx = true;
    }
    if (++this.pending >= BATCH_ROWS) this.commit();
  }

  commit(): void {
    if (!this.inTx) return;
    this.conn.exec('COMMIT');
    this.inTx = false;
    this.pending = 0;
  }

  rollback(): void {
    if (!this.inTx) return;
    try {
      this.conn.exec('ROLLBACK');
    } catch {
      /* 已被自动回滚 */
    }
    this.inTx = false;
    this.pending = 0;
  }
}

export async function fillFromMdict(
  conn: DatabaseSync,
  dictId: number,
  bundle: MdictBundle,
  label: string,
  onProgress?: ProgressFn,
): Promise<MdictImportResult> {
  const counts: Counts = { real: 0, alias: 0, dangling: 0, redundant: 0, media: 0 };
  const mediaBase = mediaUrlBase(dictId);
  const file = await MdictFile.open(await fileSource(bundle.mdxPath), false);
  const writer = new BatchWriter(conn);

  try {
    onProgress?.({
      phase: 'parse',
      file: label,
      message: `${file.entryCount} 个词头 / ${file.stats.recordBlocks} 个记录块`,
      progress: 0,
    });

    // 临时表只在本次导入期间存在，用来把「别名指向的词头字符串」解析成行 id
    conn.exec('DROP TABLE IF EXISTS temp.mdict_key_map');
    conn.exec('DROP TABLE IF EXISTS temp.mdict_alias');
    conn.exec('CREATE TABLE temp.mdict_key_map(raw_key TEXT PRIMARY KEY, term_id INTEGER NOT NULL) WITHOUT ROWID');
    conn.exec('CREATE TABLE temp.mdict_alias(term_id INTEGER PRIMARY KEY, target_key TEXT NOT NULL)');

    const insertTerm = conn.prepare(
      `INSERT INTO terms
       (dict_id, expression, reading, expression_norm, reading_norm, definition_tags, term_tags, rules, score, sequence, glossary_json, alias_of)
       VALUES (?, ?, ?, ?, ?, '', '', '', ?, -1, ?, NULL)`,
    );
    const mapKey = conn.prepare('INSERT OR IGNORE INTO temp.mdict_key_map(raw_key, term_id) VALUES (?, ?)');
    const addAlias = conn.prepare('INSERT OR IGNORE INTO temp.mdict_alias(term_id, target_key) VALUES (?, ?)');

    const addRow = (expression: string, reading: string, glossaryJson: string, score: number): number => {
      const info = insertTerm.run(
        dictId,
        expression,
        reading,
        normalizeKey(expression),
        normalizeKey(reading),
        score,
        glossaryJson,
      );
      writer.tick();
      return Number(info.lastInsertRowid);
    };

    await file.forEachRecord(
      (rawKey, data) => {
        if (data.length === 0) return;
        const parts = cleanMdictKey(rawKey);
        if (!parts.expression) return;

        if (looksLikeAlias(data)) {
          const target = parseAliasTarget(file.decodeText(data));
          if (!target) return;
          const id = addRow(parts.expression, parts.reading, '[]', -1);
          mapKey.run(rawKey, id);
          addAlias.run(id, target);
          counts.alias++;
          return;
        }

        const html = sanitizeEntryHtml(file.decodeText(data), { mediaBase });
        if (!html) return;
        const id = addRow(parts.expression, parts.reading, JSON.stringify([{ type: 'html', html }]), 0);
        mapKey.run(rawKey, id);
        counts.real++;

        // 【良い・善い・好い】里的异形也要能被检索到，指回同一条释义
        for (const form of parts.altForms) {
          if (!form || form === parts.expression) continue;
          const aliasId = addRow(form, parts.reading, '[]', -1);
          conn.prepare('UPDATE terms SET alias_of = ? WHERE id = ?').run(id, aliasId);
          counts.alias++;
        }
      },
      (done, total) => {
        if (done % 64 === 0 || done === total) {
          onProgress?.({
            phase: 'write',
            file: label,
            message: `写入词条 ${counts.real + counts.alias}（记录块 ${done}/${total}）`,
            progress: (done / total) * 0.9,
          });
        }
      },
    );
    writer.commit();

    onProgress?.({ phase: 'index', file: label, message: '解析 @@@LINK 重定向', progress: 0.92 });
    resolveAliases(conn, dictId, counts);

    /* ---- 配套 CSS ---- */
    let hasStyle = false;
    if (bundle.cssPath) {
      const rawCss = fs.readFileSync(bundle.cssPath, 'utf8');
      const scoped = scopeCss(rawCss, mdictScopeClass(dictId), mediaBase);
      conn.prepare('UPDATE dictionaries SET css = ? WHERE id = ?').run(scoped, dictId);
      hasStyle = scoped.length > 0;
    }

    /* ---- 配套 .mdd 资源 ---- */
    for (const mddPath of bundle.mddPaths) {
      onProgress?.({ phase: 'write', file: label, message: `解包 ${path.basename(mddPath)}`, progress: 0.96 });
      counts.media += await extractMdd(mddPath, dictId);
    }

    const rows = colNum(conn.prepare('SELECT COUNT(*) AS n FROM terms WHERE dict_id = ?').get(dictId)?.n ?? 0);
    return { ...counts, rows, hasStyle };
  } catch (err) {
    writer.rollback();
    throw err;
  } finally {
    conn.exec('DROP TABLE IF EXISTS temp.mdict_key_map');
    conn.exec('DROP TABLE IF EXISTS temp.mdict_alias');
    await file.close();
  }
}

/** 把别名行的 target_key 解析成行 id，压平多跳，删掉断链与冗余 */
function resolveAliases(conn: DatabaseSync, dictId: number, counts: Counts): void {
  conn.exec('BEGIN');
  try {
    conn
      .prepare(
        `UPDATE terms SET alias_of = (
           SELECT m.term_id FROM temp.mdict_alias a JOIN temp.mdict_key_map m ON m.raw_key = a.target_key
           WHERE a.term_id = terms.id)
         WHERE id IN (SELECT term_id FROM temp.mdict_alias)`,
      )
      .run();

    // 目标本身还是别名 → 继续往上指，直到全是单跳
    const flatten = conn.prepare(
      `UPDATE terms SET alias_of = (SELECT p.alias_of FROM terms p WHERE p.id = terms.alias_of)
       WHERE dict_id = ? AND alias_of IS NOT NULL
         AND (SELECT p.alias_of FROM terms p WHERE p.id = terms.alias_of) IS NOT NULL`,
    );
    for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
      if (Number(flatten.run(dictId).changes) === 0) break;
    }
    // 仍未压平的只可能是环，直接断开（随后会被当作断链删掉）
    conn
      .prepare(
        `UPDATE terms SET alias_of = NULL
         WHERE dict_id = ? AND alias_of IS NOT NULL
           AND alias_of IN (SELECT id FROM terms WHERE dict_id = ? AND alias_of IS NOT NULL)`,
      )
      .run(dictId, dictId);

    counts.dangling = Number(
      conn
        .prepare('DELETE FROM terms WHERE id IN (SELECT term_id FROM temp.mdict_alias) AND alias_of IS NULL')
        .run().changes,
    );

    // 别名与目标的检索键完全一致时（学校 → ░がっこう░【学校】），别名行纯属冗余
    counts.redundant = Number(
      conn
        .prepare(
          `DELETE FROM terms WHERE dict_id = ? AND alias_of IS NOT NULL AND EXISTS (
             SELECT 1 FROM terms t2 WHERE t2.id = terms.alias_of
               AND t2.expression_norm = terms.expression_norm
               AND (terms.reading_norm = '' OR t2.reading_norm = terms.reading_norm))`,
        )
        .run(dictId).changes,
    );

    // 指向同一目标、检索键又相同的重复别名只留一条
    counts.redundant += Number(
      conn
        .prepare(
          `DELETE FROM terms WHERE dict_id = ? AND alias_of IS NOT NULL AND id NOT IN (
             SELECT MIN(id) FROM terms WHERE dict_id = ? AND alias_of IS NOT NULL
             GROUP BY expression_norm, reading_norm, alias_of)`,
        )
        .run(dictId, dictId).changes,
    );
    conn.exec('COMMIT');
  } catch (err) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      /* 已被自动回滚 */
    }
    throw err;
  }
}

/** .mdd 与 .mdx 格式相同，只是记录是二进制资源，键形如 `\us\a.png` */
async function extractMdd(mddPath: string, dictId: number): Promise<number> {
  const file = await MdictFile.open(await fileSource(mddPath), true);
  let n = 0;
  try {
    await file.forEachRecord((key, data) => {
      if (writeMedia(dictId, key, data)) n++;
    });
  } finally {
    await file.close();
  }
  return n;
}

/** 供 zip 内的 mdx 使用：先落到临时目录，再走统一的文件路径 */
export async function mdictFromBuffer(data: Buffer, isMdd: boolean): Promise<MdictFile> {
  return MdictFile.open(bufferSource(data), isMdd);
}
