/**
 * LZO1X 解压（纯 JS，移植自 minilzo 的 lzo1x_decompress_safe）。
 *
 * MDict 的压缩类型 1 就是裸 LZO1X 流（python-lzo 那层 `\xf0`+长度 的头由调用方自己给出，
 * 这里直接要求传入解压后长度）。明镜这部词典全是 zlib，但 MDict 生态里 LZO 词典很多。
 *
 * 指令格式速查（t 为操作码）：
 *   t >= 64  M2 匹配，长度 (t>>5)+1，偏移由 t 与后 1 字节给出
 *   t >= 32  M3 匹配，长度 (t&31)+2（为 0 时用扩展字节），偏移取后 2 字节
 *   t >= 16  M4 匹配，含 EOF 标记（0x11 0x00 0x00）
 *   t < 16   首次为字面量游程，其后为 M1 短匹配
 */

class LzoError extends Error {}

export function lzo1xDecompress(src: Uint8Array, dstLen: number): Uint8Array {
  const dst = new Uint8Array(dstLen);
  let ip = 0;
  let op = 0;

  const needIn = (n: number): void => {
    if (ip + n > src.length) throw new LzoError('LZO 数据在输入端提前结束');
  };
  const needOut = (n: number): void => {
    if (op + n > dstLen) throw new LzoError('LZO 输出超过声明长度');
  };
  /** 逐字节复制，必须允许重叠（LZO 用重叠复制实现游程扩展） */
  const copyMatch = (from: number, n: number): void => {
    if (from < 0) throw new LzoError('LZO 匹配偏移越界');
    needOut(n);
    for (let i = 0; i < n; i++) dst[op++] = dst[from++];
  };
  const copyLiteral = (n: number): void => {
    needIn(n);
    needOut(n);
    for (let i = 0; i < n; i++) dst[op++] = src[ip++];
  };
  /** t == 0 时长度由若干 0x00 加最后一个非零字节延长 */
  const extendLength = (base: number): number => {
    let t = 0;
    needIn(1);
    while (src[ip] === 0) {
      t += 255;
      ip++;
      needIn(1);
    }
    return t + base + src[ip++];
  };

  let t = 0;
  let mPos = 0;
  let state: 'top' | 'firstLiteralRun' | 'match' | 'matchNext' = 'top';

  needIn(1);
  if (src[ip] > 17) {
    t = src[ip++] - 17;
    if (t < 4) {
      state = 'matchNext';
    } else {
      copyLiteral(t);
      state = 'firstLiteralRun';
    }
  }

  for (;;) {
    if (state === 'top') {
      needIn(1);
      t = src[ip++];
      if (t >= 16) {
        state = 'match';
      } else {
        if (t === 0) t = extendLength(15);
        copyLiteral(t + 3);
        state = 'firstLiteralRun';
      }
    }

    if (state === 'firstLiteralRun') {
      needIn(1);
      t = src[ip++];
      if (t >= 16) {
        state = 'match';
      } else {
        // M2 的最短形式：固定 3 字节匹配，偏移 0x801 起
        needIn(1);
        mPos = op - 0x801 - (t >> 2) - (src[ip++] << 2);
        copyMatch(mPos, 3);
        state = 'matchNext';
        // 走到 matchNext 前需要先算 t = ip[-2] & 3
        t = src[ip - 2] & 3;
        if (t === 0) {
          state = 'top';
          continue;
        }
      }
    }

    while (state === 'match' || state === 'matchNext') {
      if (state === 'match') {
        if (t >= 64) {
          needIn(1);
          mPos = op - 1 - ((t >> 2) & 7) - (src[ip++] << 3);
          t = (t >> 5) - 1;
          copyMatch(mPos, t + 2);
        } else if (t >= 32) {
          t &= 31;
          if (t === 0) t = extendLength(31);
          needIn(2);
          mPos = op - 1 - ((src[ip] >> 2) + (src[ip + 1] << 6));
          ip += 2;
          copyMatch(mPos, t + 2);
        } else if (t >= 16) {
          mPos = op - ((t & 8) << 11);
          t &= 7;
          if (t === 0) t = extendLength(7);
          needIn(2);
          mPos -= (src[ip] >> 2) + (src[ip + 1] << 6);
          ip += 2;
          if (mPos === op) return dst.subarray(0, op); // EOF 标记
          mPos -= 0x4000;
          copyMatch(mPos, t + 2);
        } else {
          needIn(1);
          mPos = op - 1 - (t >> 2) - (src[ip++] << 2);
          copyMatch(mPos, 2);
        }
        t = src[ip - 2] & 3;
        if (t === 0) {
          state = 'top';
          break;
        }
        state = 'matchNext';
      }

      if (state === 'matchNext') {
        copyLiteral(t);
        needIn(1);
        t = src[ip++];
        state = 'match';
      }
    }
  }
}
