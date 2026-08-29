/**
 * 最小 ZIP 读取器：解析中央目录后按需随机读取单个条目。
 *
 * 为什么不用 fflate 的 unzip/unzipSync：它们要求整个 zip 先进内存，
 * 200MB+ 的 JMdict / 明鏡直接把堆吃满；而流式的 fflate.Unzip 对「跳过不读的条目」
 * 会把压缩数据一直缓存在内部数组里，同样会涨内存。
 * 这里自己走中央目录，任何时刻只持有一个条目的压缩 + 解压数据。
 */
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { inflateSync } from 'fflate';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** ZIP 允许的最大注释长度 + EOCD 自身长度 */
const EOCD_SEARCH_MAX = 65557 + 22;

export interface ZipEntry {
  /** zip 内相对路径，始终使用 / 分隔 */
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isDirectory: boolean;
}

const utf8 = new TextDecoder('utf-8');
const utf8Fatal = new TextDecoder('utf-8', { fatal: true });
const gb18030Fatal = new TextDecoder('gb18030', { fatal: true });
const latin1 = new TextDecoder('latin1');

/** Info-ZIP Unicode Path extra field (0x7075)：旧工具可用它补充真正的 UTF-8 文件名。 */
function unicodePathFromExtra(extra: Buffer): string | null {
  let i = 0;
  while (i + 4 <= extra.length) {
    const id = extra.readUInt16LE(i);
    const size = extra.readUInt16LE(i + 2);
    const body = extra.subarray(i + 4, i + 4 + size);
    i += 4 + size;
    if (id !== 0x7075 || body.length < 6 || body[0] !== 1) continue;
    try {
      return utf8Fatal.decode(body.subarray(5));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 位 11 未置位时，规范默认 CP437，但中文 Windows 压缩工具通常直接写 GBK。
 * 优先 Unicode extra/有效 UTF-8；只有 GB18030 能解出至少两个中日韩字符时才采用，
 * 否则沿用 latin1 兜底，避免普通西文文件名被猜成中文。
 */
function decodeEntryName(bytes: Buffer, flags: number, extra: Buffer): string {
  if ((flags & 0x0800) !== 0) return utf8.decode(bytes);
  const unicode = unicodePathFromExtra(extra);
  if (unicode) return unicode;
  try {
    return utf8Fatal.decode(bytes);
  } catch {
    /* 不是 UTF-8，继续尝试 Windows 中文 ZIP 常见编码 */
  }
  try {
    const decoded = gb18030Fatal.decode(bytes);
    const cjk = decoded.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/gu)?.length ?? 0;
    if (cjk >= 2) return decoded;
  } catch {
    /* 不是有效 GB18030 */
  }
  return latin1.decode(bytes);
}

function readUInt64LE(buf: Buffer, off: number): number {
  const value = buf.readBigUInt64LE(off);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ZIP 条目过大，无法处理');
  return Number(value);
}

/** zip64 扩展字段：只有当 32 位字段为 0xffffffff 时才依次出现对应的 64 位值 */
function applyZip64Extra(
  extra: Buffer,
  need: { uncompressedSize: boolean; compressedSize: boolean; offset: boolean },
): { uncompressedSize?: number; compressedSize?: number; offset?: number } {
  const out: { uncompressedSize?: number; compressedSize?: number; offset?: number } = {};
  let i = 0;
  while (i + 4 <= extra.length) {
    const id = extra.readUInt16LE(i);
    const size = extra.readUInt16LE(i + 2);
    const body = extra.subarray(i + 4, i + 4 + size);
    i += 4 + size;
    if (id !== 0x0001) continue;
    let p = 0;
    if (need.uncompressedSize && p + 8 <= body.length) {
      out.uncompressedSize = readUInt64LE(body, p);
      p += 8;
    }
    if (need.compressedSize && p + 8 <= body.length) {
      out.compressedSize = readUInt64LE(body, p);
      p += 8;
    }
    if (need.offset && p + 8 <= body.length) {
      out.offset = readUInt64LE(body, p);
      p += 8;
    }
    break;
  }
  return out;
}

export class ZipReader {
  // 不用构造器参数属性：node --experimental-strip-types 只做类型擦除，不支持这种语法
  readonly entries: ZipEntry[];
  private readonly fh: FileHandle;

  private constructor(fh: FileHandle, entries: ZipEntry[]) {
    this.fh = fh;
    this.entries = entries;
  }

  static async open(absPath: string): Promise<ZipReader> {
    const fh = await open(absPath, 'r');
    try {
      const { size } = await fh.stat();
      const entries = await readCentralDirectory(fh, size);
      return new ZipReader(fh, entries);
    } catch (err) {
      await fh.close();
      throw err;
    }
  }

  private async readAt(position: number, length: number): Promise<Buffer> {
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await this.fh.read(buf, read, length - read, position + read);
      if (bytesRead <= 0) break;
      read += bytesRead;
    }
    return read === length ? buf : buf.subarray(0, read);
  }

  /** 解压单个条目 */
  async read(entry: ZipEntry): Promise<Uint8Array> {
    if (entry.isDirectory) return new Uint8Array(0);
    // 本地头的 extra 长度可能与中央目录不同，必须重新读一次才能定位数据起点
    const head = await this.readAt(entry.localHeaderOffset, 30);
    if (head.length < 30 || head.readUInt32LE(0) !== SIG_LOCAL) {
      throw new Error(`ZIP 条目本地头损坏: ${entry.name}`);
    }
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + 30 + nameLen + extraLen;
    const raw = await this.readAt(dataOffset, entry.compressedSize);
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    if (entry.method === METHOD_STORE) return bytes;
    if (entry.method !== METHOD_DEFLATE) {
      throw new Error(`ZIP 条目使用了不支持的压缩方式 ${entry.method}: ${entry.name}`);
    }
    return entry.uncompressedSize > 0
      ? inflateSync(bytes, { out: new Uint8Array(entry.uncompressedSize) })
      : inflateSync(bytes);
  }

  async readText(entry: ZipEntry): Promise<string> {
    return utf8.decode(await this.read(entry));
  }

  async close(): Promise<void> {
    await this.fh.close();
  }
}

async function readCentralDirectory(fh: FileHandle, fileSize: number): Promise<ZipEntry[]> {
  const tailLen = Math.min(fileSize, EOCD_SEARCH_MAX);
  const tail = Buffer.allocUnsafe(tailLen);
  await fh.read(tail, 0, tailLen, fileSize - tailLen);

  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件（找不到中央目录）');

  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);

  if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === SIG_EOCD64_LOCATOR) {
    const eocd64Offset = readUInt64LE(tail, eocd - 20 + 8);
    const head = Buffer.allocUnsafe(56);
    await fh.read(head, 0, 56, eocd64Offset);
    if (head.readUInt32LE(0) === SIG_EOCD64) {
      count = readUInt64LE(head, 32);
      cdSize = readUInt64LE(head, 40);
      cdOffset = readUInt64LE(head, 48);
    }
  }

  const cd = Buffer.allocUnsafe(cdSize);
  await fh.read(cd, 0, cdSize, cdOffset);

  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== SIG_CENTRAL) break;
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    let compressedSize = cd.readUInt32LE(p + 20);
    let uncompressedSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localHeaderOffset = cd.readUInt32LE(p + 42);
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    p += 46 + nameLen + extraLen + commentLen;

    const z64 = applyZip64Extra(extra, {
      uncompressedSize: uncompressedSize === 0xffffffff,
      compressedSize: compressedSize === 0xffffffff,
      offset: localHeaderOffset === 0xffffffff,
    });
    if (z64.uncompressedSize !== undefined) uncompressedSize = z64.uncompressedSize;
    if (z64.compressedSize !== undefined) compressedSize = z64.compressedSize;
    if (z64.offset !== undefined) localHeaderOffset = z64.offset;

    const name = decodeEntryName(nameBytes, flags, extra).replace(/\\/g, '/');
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory: name.endsWith('/'),
    });
  }
  return entries;
}
