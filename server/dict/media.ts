/** 词典内嵌媒体的落盘位置：MEDIA_DIR/<dictId>/<词典内相对路径> */
import fs from 'node:fs';
import path from 'node:path';
import { MEDIA_DIR } from '../config.ts';

export function mediaRoot(dictId: number): string {
  return path.join(MEDIA_DIR, String(dictId));
}

/** HTTP 层用的前缀，与 server/index.ts 的 /api/media/:id/* 路由对应 */
export function mediaUrlBase(dictId: number): string {
  return `/api/media/${dictId}/`;
}

/** 返回 false 表示路径越界被拒 */
export function writeMedia(dictId: number, relPath: string, data: Uint8Array): boolean {
  const root = mediaRoot(dictId);
  const clean = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean) return false;
  const dest = path.resolve(root, clean);
  // 防 zip slip：解析后必须仍在该词典的媒体目录内
  if (dest !== root && !dest.startsWith(root + path.sep)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, data);
  return true;
}

export function removeMedia(dictId: number): void {
  fs.rmSync(mediaRoot(dictId), { recursive: true, force: true });
}
