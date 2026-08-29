/**
 * RIPEMD-128。
 * MDict 只用它一处：Encrypted=2 时由 key block info 的第 4..8 字节派生解混淆密钥。
 * 实现按 RIPEMD 参考伪码：4 个 32 位状态、双线各 64 轮、MD4 式填充、小端输出。
 */

// prettier-ignore
const RL = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
  3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
  1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
];
// prettier-ignore
const RR = [
  5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
  6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
  15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
  8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
];
// prettier-ignore
const SL = [
  11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
  7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
  11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
  11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
];
// prettier-ignore
const SR = [
  8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
  9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
  9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
  15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
];

const KL = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc];
const KR = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x00000000];

function f(round: number, x: number, y: number, z: number): number {
  if (round === 0) return x ^ y ^ z;
  if (round === 1) return (x & y) | (~x & z);
  if (round === 2) return (x | ~y) ^ z;
  return (x & z) | (y & ~z);
}

function rotl(v: number, n: number): number {
  return (v << n) | (v >>> (32 - n));
}

export function ripemd128(input: Uint8Array): Uint8Array {
  // MD4 式填充：0x80、补零到 56 mod 64、64 位小端比特长度
  const bitLenLo = (input.length << 3) >>> 0;
  const bitLenHi = Math.floor(input.length / 0x20000000) >>> 0;
  const padded = new Uint8Array(((input.length + 8) >> 6 << 6) + 64);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLenLo, true);
  view.setUint32(padded.length - 4, bitLenHi, true);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;

  const x = new Int32Array(16);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) x[i] = view.getInt32(block + i * 4, true);

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let aa = h0;
    let bb = h1;
    let cc = h2;
    let dd = h3;

    for (let i = 0; i < 64; i++) {
      const round = i >> 4;
      let t = (a + f(round, b, c, d) + x[RL[i]] + KL[round]) | 0;
      t = rotl(t, SL[i]);
      a = d;
      d = c;
      c = b;
      b = t;

      t = (aa + f(3 - round, bb, cc, dd) + x[RR[i]] + KR[round]) | 0;
      t = rotl(t, SR[i]);
      aa = dd;
      dd = cc;
      cc = bb;
      bb = t;
    }

    const t = (h1 + c + dd) | 0;
    h1 = (h2 + d + aa) | 0;
    h2 = (h3 + a + bb) | 0;
    h3 = (h0 + b + cc) | 0;
    h0 = t;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setInt32(0, h0, true);
  outView.setInt32(4, h1, true);
  outView.setInt32(8, h2, true);
  outView.setInt32(12, h3, true);
  return out;
}

export function ripemd128Hex(input: Uint8Array): string {
  return Buffer.from(ripemd128(input)).toString('hex');
}
