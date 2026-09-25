import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 用户把 Yomitan zip 或 MDict mdx（含配套 CSS/MDD）放进此目录，服务启动时自动识别导入 */
export const DICT_DIR = path.resolve(process.env.JP_DICT_DIR || path.join(ROOT, 'dictionaries'));
export const DATA_DIR = path.resolve(process.env.JP_DATA_DIR || path.join(ROOT, 'data'));
export const DB_PATH = path.join(DATA_DIR, 'dictionaries.db');
/** 词典内嵌图片解包后的位置 */
export const MEDIA_DIR = path.join(DATA_DIR, 'media');

export const PORT = Number(process.env.PORT || 8787);
export const HOST = process.env.JP_HOST || '127.0.0.1';
export const MAX_TEXT_LENGTH = Number(process.env.JP_MAX_TEXT || 20000);

export function ensureDirs(): void {
  for (const dir of [DICT_DIR, DATA_DIR, MEDIA_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
