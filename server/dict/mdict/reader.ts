/**
 * MDict (.mdx / .mdd) 读取器。
 *
 * 文件布局：
 *   [4B headerLen][headerLen 字节 UTF-16LE 的 XML][4B adler32]
 *   key 区：  v2 是 5 个 uint64BE + 4B adler32；v1.x 是 4 个 uint32BE 且无校验
 *            → key block info（v2 压缩，Encrypted&2 时先解混淆）→ 若干 key block
 *   record 区：4 个数字 → (压缩长, 解压长) 列表 → 若干 record block
 *
 * key 里存的偏移是「所有 record block 解压后首尾相接」这条虚拟流上的位置，
 * 所以这里逐块解压并维护一个滑动窗口，随时只保留一个块加一条跨界记录的数据。
 */
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { lzo1xDecompress } from './lzo1x.ts';
import { ripemd128 } from './ripemd128.ts';

export interface MdictHeader {
  raw: Record<string, string>;
  /** 1.2 或 2.0 */
  version: number;
  encoding: string;
  /** 位 0 = 记录加密（不支持），位 1 = key info 混淆（支持） */
  encrypted: number;
  title: string;
  description: string;
  /** 'Html' | 'Text' */
  format: string;
  /** 编号 → [前缀, 后缀]，记录文本里的 `n` 标记要展开成这两段 */
  stylesheet: Map<string, [string, string]>;
}

export interface MdictStats {
  keyBlocks: number;
  recordBlocks: number;
  entries: number;
  /** 记录流解压后的总字节数 */
  recordBytes: number;
}

/** 读取字节的抽象：文件或内存缓冲 */
export interface ByteSource {
  size: number;
  read(position: number, length: number): Promise<Buffer>;
  close(): Promise<void>;
}

export async function fileSource(absPath: string): Promise<ByteSource> {
  const fh: FileHandle = await open(absPath, 'r');
  const { size } = await fh.stat();
  return {
    size,
    async read(position, length) {
      const buf = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await fh.read(buf, read, length - read, position + read);
        if (bytesRead <= 0) break;
        read += bytesRead;
      }
      if (read !== length) throw new Error('MDict 文件在预期位置提前结束');
      return buf;
    },
    async close() {
      await fh.close();
    },
  };
}

export function bufferSource(data: Buffer): ByteSource {
  return {
    size: data.length,
    async read(position, length) {
      if (position + length > data.length) throw new Error('MDict 数据在预期位置提前结束');
      return data.subarray(position, position + length);
    },
    async close() {},
  };
}

/* ────────────────────────── 基础解码 ────────────────────────── */

const XML_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  amp: '&',
  nbsp: '\u00a0',
};

/** header XML 里的属性值是转义过的，Description 尤其明显 */
export function unescapeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function normalizeEncoding(raw: string, isMdd: boolean): string {
  // mdd 的键固定是 UTF-16LE，header 里的 Encoding 只对 mdx 有意义
  if (isMdd) return 'utf-16le';
  const key = raw.toUpperCase().replace(/[-_ ]/g, '');
  if (key === 'UTF16' || key === 'UTF16LE') return 'utf-16le';
  if (key === 'GBK' || key === 'GB2312' || key === 'GB18030') return 'gbk';
  if (key === 'BIG5' || key === 'BIG5HKSCS') return 'big5';
  return 'utf-8';
}

function decodeWith(encoding: string, bytes: Uint8Array): string {
  return new TextDecoder(encoding).decode(bytes);
}

/** 块头：4B 压缩类型（小端）+ 4B adler32，其后是数据 */
function decompressBlock(block: Buffer, decompLen: number, what: string): Uint8Array {
  if (block.length < 8) throw new Error(`${what} 数据块过短`);
  const type = block.readUInt32LE(0);
  const body = block.subarray(8);
  if (type === 0) return body;
  if (type === 1) return lzo1xDecompress(body, decompLen);
  if (type === 2) return inflateSync(body);
  throw new Error(`${what} 使用了不支持的压缩类型 ${type}`);
}

/**
 * Encrypted=2 的 key block info 混淆：
 * 密钥 = ripemd128(块的 4..8 字节 ‖ 95 36 00 00)，从第 8 字节起逐字节反混淆。
 */
function deobfuscate(block: Buffer): Buffer {
  const seed = Buffer.concat([block.subarray(4, 8), Buffer.from([0x95, 0x36, 0x00, 0x00])]);
  const key = ripemd128(seed);
  const out = Buffer.from(block);
  let previous = 0x36;
  for (let i = 8; i < out.length; i++) {
    const cur = out[i];
    let t = ((cur >> 4) | (cur << 4)) & 0xff;
    t = t ^ previous ^ ((i - 8) & 0xff) ^ key[(i - 8) % key.length];
    previous = cur; // 注意是原始字节，不是解出来的字节
    out[i] = t;
  }
  return out;
}

/* ────────────────────────── 主体 ────────────────────────── */

interface BlockSize {
  comp: number;
  decomp: number;
}

export class MdictFile {
  readonly header: MdictHeader;
  readonly stats: MdictStats;
  /** 与 keys 一一对应的记录流偏移 */
  private readonly offsets: Float64Array;
  private readonly keys: string[];
  private readonly recordStart: number;
  private readonly recordSizes: BlockSize[];
  private readonly source: ByteSource;
  private readonly isMdd: boolean;

  private constructor(init: {
    header: MdictHeader;
    stats: MdictStats;
    keys: string[];
    offsets: Float64Array;
    recordStart: number;
    recordSizes: BlockSize[];
    source: ByteSource;
    isMdd: boolean;
  }) {
    this.header = init.header;
    this.stats = init.stats;
    this.keys = init.keys;
    this.offsets = init.offsets;
    this.recordStart = init.recordStart;
    this.recordSizes = init.recordSizes;
    this.source = init.source;
    this.isMdd = init.isMdd;
  }

  static async open(source: ByteSource, isMdd: boolean): Promise<MdictFile> {
    try {
      return await MdictFile.parse(source, isMdd);
    } catch (err) {
      await source.close();
      throw err;
    }
  }

  private static async parse(source: ByteSource, isMdd: boolean): Promise<MdictFile> {
    const headerLen = (await source.read(0, 4)).readUInt32BE(0);
    if (headerLen <= 0 || headerLen + 8 > source.size) throw new Error('不是有效的 MDict 文件（头部长度异常）');
    const xml = (await source.read(4, headerLen)).toString('utf16le');
    const raw: Record<string, string> = {};
    for (const m of xml.matchAll(/(\w+)="([^"]*)"/g)) raw[m[1]] = unescapeXml(m[2]);

    const version = Number.parseFloat(raw.GeneratedByEngineVersion || raw.RequiredEngineVersion || '1.2') || 1.2;
    const encryptedRaw = raw.Encrypted ?? '0';
    const encrypted =
      encryptedRaw === 'No' || encryptedRaw === '' ? 0 : encryptedRaw === 'Yes' ? 1 : Number(encryptedRaw) || 0;
    if (encrypted & 0x01) {
      throw new Error('该 MDict 词典的记录区经过用户密码加密（Encrypted=1），本程序无法解密，请使用未加密的版本');
    }

    const stylesheet = new Map<string, [string, string]>();
    if (raw.StyleSheet) {
      const lines = raw.StyleSheet.split(/\r\n|[\r\n]/);
      for (let i = 0; i + 2 < lines.length; i += 3) stylesheet.set(lines[i], [lines[i + 1], lines[i + 2]]);
    }

    const header: MdictHeader = {
      raw,
      version,
      encoding: normalizeEncoding(raw.Encoding ?? '', isMdd),
      encrypted,
      title: raw.Title ?? '',
      description: raw.Description ?? '',
      format: raw.Format ?? 'Html',
      stylesheet,
    };

    const wide = version >= 2;
    const numWidth = wide ? 8 : 4;
    const readNum = (buf: Buffer, off: number): number => {
      if (!wide) return buf.readUInt32BE(off);
      const value = buf.readBigUInt64BE(off);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('MDict 文件中的长度字段超出可处理范围');
      return Number(value);
    };

    /* ---- key 区头部 ---- */
    let pos = 4 + headerLen + 4;
    const headFields = wide ? 5 : 4;
    const keyHead = await source.read(pos, numWidth * headFields);
    pos += numWidth * headFields + (wide ? 4 : 0);
    let f = 0;
    const numKeyBlocks = readNum(keyHead, numWidth * f++);
    const numEntries = readNum(keyHead, numWidth * f++);
    const keyInfoDecompLen = wide ? readNum(keyHead, numWidth * f++) : -1;
    const keyInfoLen = readNum(keyHead, numWidth * f++);
    const keyBlocksLen = readNum(keyHead, numWidth * f++);

    /* ---- key block info ---- */
    let info = await source.read(pos, keyInfoLen);
    pos += keyInfoLen;
    if (wide) {
      if (encrypted & 0x02) info = deobfuscate(info);
      const decoded = decompressBlock(info, keyInfoDecompLen, 'key block info');
      // 最强的正确性信号：解出来的长度必须和头部声明的一致
      if (keyInfoDecompLen >= 0 && decoded.length !== keyInfoDecompLen) {
        throw new Error(`key block info 解码失败（得到 ${decoded.length} 字节，头部声明 ${keyInfoDecompLen} 字节）`);
      }
      info = Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength);
    }
    const keySizes = parseKeyBlockInfo(info, version, header.encoding, numKeyBlocks);

    /* ---- key blocks ---- */
    const keys: string[] = [];
    const offsetList: number[] = [];
    let keyPos = pos;
    for (const size of keySizes) {
      const block = await source.read(keyPos, size.comp);
      keyPos += size.comp;
      const decoded = decompressBlock(block, size.decomp, 'key block');
      splitKeyBlock(decoded, numWidth, header.encoding, keys, offsetList);
    }
    pos += keyBlocksLen;

    /* ---- record 区头部 ---- */
    const recHead = await source.read(pos, numWidth * 4);
    pos += numWidth * 4;
    const numRecordBlocks = readNum(recHead, 0);
    const recInfoLen = readNum(recHead, numWidth * 2);
    const recSizesBuf = await source.read(pos, recInfoLen);
    pos += recInfoLen;
    const recordSizes: BlockSize[] = [];
    let recordBytes = 0;
    for (let i = 0; i < numRecordBlocks; i++) {
      const comp = readNum(recSizesBuf, i * numWidth * 2);
      const decomp = readNum(recSizesBuf, i * numWidth * 2 + numWidth);
      recordSizes.push({ comp, decomp });
      recordBytes += decomp;
    }

    return new MdictFile({
      header,
      stats: { keyBlocks: numKeyBlocks, recordBlocks: numRecordBlocks, entries: numEntries || keys.length, recordBytes },
      keys,
      offsets: Float64Array.from(offsetList),
      recordStart: pos,
      recordSizes,
      source,
      isMdd,
    });
  }

  get entryCount(): number {
    return this.keys.length;
  }

  /**
   * 逐条产出记录。cb 收到的 data 是解压缓冲的视图，回调返回后即可能失效，
   * 需要保留请自行复制（decodeText 会复制）。
   */
  async forEachRecord(
    cb: (key: string, data: Uint8Array, index: number) => void,
    onBlock?: (done: number, total: number) => void,
  ): Promise<void> {
    const total = this.stats.recordBytes;
    let pending: Uint8Array = new Uint8Array(0);
    /** pending[0] 在虚拟流中的绝对偏移 */
    let windowStart = 0;
    let next = 0;
    let filePos = this.recordStart;

    for (let b = 0; b < this.recordSizes.length; b++) {
      const size = this.recordSizes[b];
      const block = await this.source.read(filePos, size.comp);
      filePos += size.comp;
      const decoded = decompressBlock(block, size.decomp, 'record block');

      if (pending.length === 0) {
        pending = decoded;
      } else {
        // 仅在上一条记录跨块时发生
        const merged = new Uint8Array(pending.length + decoded.length);
        merged.set(pending);
        merged.set(decoded, pending.length);
        pending = merged;
      }

      const available = windowStart + pending.length;
      while (next < this.keys.length) {
        const start = this.offsets[next];
        const end = next + 1 < this.keys.length ? this.offsets[next + 1] : total;
        if (end > available) break;
        cb(this.keys[next], pending.subarray(start - windowStart, end - windowStart), next);
        next++;
      }

      const consumed = next < this.keys.length ? this.offsets[next] : available;
      if (consumed > windowStart) {
        // 复制而不是 subarray：subarray 会把整块 buffer 一起留住
        const keep = pending.subarray(consumed - windowStart);
        pending = keep.length ? new Uint8Array(keep) : new Uint8Array(0);
        windowStart = consumed;
      }
      onBlock?.(b + 1, this.recordSizes.length);
    }
  }

  /** 记录字节 → 文本（去掉结尾 NUL，必要时展开 StyleSheet 标记） */
  decodeText(data: Uint8Array): string {
    let end = data.length;
    const step = this.header.encoding === 'utf-16le' ? 2 : 1;
    while (end >= step && data[end - 1] === 0 && (step === 1 || data[end - 2] === 0)) end -= step;
    const text = decodeWith(this.header.encoding, data.subarray(0, end));
    return this.header.stylesheet.size ? applyStylesheet(text, this.header.stylesheet) : text;
  }

  async close(): Promise<void> {
    await this.source.close();
  }
}

/** 记录文本里的 `1` 标记要展开成 StyleSheet 中编号 1 的前后缀 */
function applyStylesheet(text: string, sheet: Map<string, [string, string]>): string {
  if (!text.includes('`')) return text;
  const parts = text.split(/`(\d+)`/);
  let out = parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    const style = sheet.get(parts[i]);
    const body = parts[i + 1] ?? '';
    if (!style) {
      out += body;
      continue;
    }
    out += body.endsWith('\n') ? style[0] + body.trimEnd() + style[1] + '\r\n' : style[0] + body + style[1];
  }
  return out;
}

/**
 * key block info：每块依次是
 * 条目数、首词长+首词+终止符、末词长+末词+终止符、压缩长、解压长。
 * v1.x 的词长是 1 字节且无终止符；UTF-16 时词长按字符数计，字节数要 ×2。
 */
function parseKeyBlockInfo(info: Buffer, version: number, encoding: string, expected: number): BlockSize[] {
  const wide = version >= 2;
  const numWidth = wide ? 8 : 4;
  const lenWidth = wide ? 2 : 1;
  const term = wide ? 1 : 0;
  const charWidth = encoding === 'utf-16le' ? 2 : 1;
  const readNum = (off: number): number => (wide ? Number(info.readBigUInt64BE(off)) : info.readUInt32BE(off));

  const out: BlockSize[] = [];
  let i = 0;
  while (i + numWidth <= info.length && out.length < expected) {
    i += numWidth; // 该块条目数，这里用不到
    for (const _ of [0, 1]) {
      const textLen = wide ? info.readUInt16BE(i) : info.readUInt8(i);
      i += lenWidth + (textLen + term) * charWidth;
    }
    const comp = readNum(i);
    i += numWidth;
    const decomp = readNum(i);
    i += numWidth;
    out.push({ comp, decomp });
  }
  if (out.length !== expected) throw new Error(`key block info 条目数不符（得到 ${out.length}，应为 ${expected}）`);
  return out;
}

/** key block 内部是「偏移 + NUL 结尾的词头」反复出现 */
function splitKeyBlock(
  block: Uint8Array,
  numWidth: number,
  encoding: string,
  keys: string[],
  offsets: number[],
): void {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const charWidth = encoding === 'utf-16le' ? 2 : 1;
  let i = 0;
  while (i + numWidth <= block.length) {
    const offset =
      numWidth === 8 ? Number(view.getBigUint64(i)) : view.getUint32(i);
    i += numWidth;
    let end = i;
    while (end + charWidth <= block.length) {
      if (block[end] === 0 && (charWidth === 1 || block[end + 1] === 0)) break;
      end += charWidth;
    }
    keys.push(decodeWith(encoding, block.subarray(i, end)));
    offsets.push(offset);
    i = end + charWidth;
  }
}
