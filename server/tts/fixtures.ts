/** Test-only synthetic MPEG framing. Not a recording or real provider audio. */
export function fixtureMp3(): Buffer {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  return Buffer.concat([frame, frame]);
}
