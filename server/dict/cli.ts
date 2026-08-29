/**
 * 命令行导入工具：npm run dict:import [-- 选项]
 *
 *   （无参数）           扫描 DICT_DIR 全量导入
 *   <file.zip|file.mdx>  导入指定词典（可给多个，相对路径按 cwd 解析）
 *   --list               列出已导入词典
 *   --rm <id> [...]      删除指定词典
 *   --enable/--disable <id>
 *   --priority <id> <n>
 */
import path from 'node:path';
import type { ImportProgress } from '../../shared/types.ts';
import { DICT_DIR } from '../config.ts';
import {
  closeDictionaries,
  deleteDictionary,
  importDictionaryFile,
  listDictionaries,
  scanAndImport,
  setDictionaryEnabled,
  setDictionaryPriority,
} from './index.ts';

let lastLine = '';

function report(p: ImportProgress): void {
  const pct = p.progress >= 0 ? `${Math.round(p.progress * 100)}%`.padStart(4) : '  --';
  const line = `[${pct}] ${p.file} — ${p.message}`;
  if (line === lastLine) return;
  lastLine = line;
  if (p.phase === 'error') console.error(line);
  else console.log(line);
}

function printTable(): void {
  const dicts = listDictionaries();
  if (!dicts.length) {
    console.log(`（暂无词典，把 Yomitan zip 或 MDict mdx 放进 ${DICT_DIR} 后重跑）`);
    return;
  }
  const rows = dicts.map((d) => [
    String(d.id),
    d.enabled ? '✓' : '×',
    String(d.priority),
    d.kind,
    d.title,
    `${d.termCount}/${d.kanjiCount}/${d.metaCount}`,
    d.revision || '-',
    d.fileName,
  ]);
  const header = ['ID', 'ON', 'PRI', 'KIND', 'TITLE', '词条/汉字/元数据', 'REV', 'FILE'];
  const widths = header.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))));
  const line = (cells: string[]) => cells.map((c, i) => c + ' '.repeat(widths[i] - width(c))).join('  ');
  console.log(line(header));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(row));
}

/** 全角字符按 2 列宽估算，表格才不会歪 */
function width(s: string): number {
  let n = 0;
  for (const ch of s) n += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return n;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--list') || argv.includes('-l')) {
    printTable();
    return;
  }

  const rmIndex = argv.findIndex((a) => a === '--rm' || a === '--remove');
  if (rmIndex >= 0) {
    const ids = argv.slice(rmIndex + 1).filter((a) => /^\d+$/.test(a));
    if (!ids.length) throw new Error('--rm 需要至少一个词典 ID（用 --list 查看）');
    for (const id of ids) {
      console.log(deleteDictionary(Number(id)) ? `已删除词典 ${id}` : `词典 ${id} 不存在`);
    }
    printTable();
    return;
  }

  for (const [flag, enabled] of [
    ['--enable', true],
    ['--disable', false],
  ] as const) {
    const i = argv.indexOf(flag);
    if (i < 0) continue;
    const id = Number(argv[i + 1]);
    if (!Number.isInteger(id)) throw new Error(`${flag} 需要一个词典 ID`);
    const meta = setDictionaryEnabled(id, enabled);
    console.log(meta ? `${meta.title} → ${enabled ? '启用' : '停用'}` : `词典 ${id} 不存在`);
    printTable();
    return;
  }

  const priIndex = argv.indexOf('--priority');
  if (priIndex >= 0) {
    const id = Number(argv[priIndex + 1]);
    const value = Number(argv[priIndex + 2]);
    if (!Number.isInteger(id) || !Number.isFinite(value)) throw new Error('--priority 用法：--priority <id> <数值>');
    const meta = setDictionaryPriority(id, value);
    console.log(meta ? `${meta.title} 优先级 → ${meta.priority}` : `词典 ${id} 不存在`);
    printTable();
    return;
  }

  const files = argv.filter((a) => !a.startsWith('-'));
  if (files.length) {
    for (const file of files) {
      const abs = path.resolve(process.cwd(), file);
      console.log(`\n导入 ${abs}`);
      const meta = await importDictionaryFile(abs, report);
      console.log(`✓ ${meta.title}（${meta.kind}）id=${meta.id}`);
    }
  } else {
    console.log(`扫描 ${DICT_DIR}`);
    const result = await scanAndImport(report);
    console.log(
      `\n导入 ${result.imported.length}，跳过 ${result.skipped.length}，失败 ${result.failed.length}`,
    );
    for (const f of result.failed) console.error(`  ✗ ${f.file}: ${f.error}`);
  }
  console.log('');
  printTable();
}

main()
  .catch((err: unknown) => {
    console.error(`\n错误：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDictionaries();
  });
