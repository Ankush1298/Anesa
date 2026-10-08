import { randomBytes } from 'node:crypto';

/** RFC 9562 UUIDv7: 48-bit unix-ms timestamp, version 7, variant 10, monotonic within a process. */
export const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let lastMs = 0;
let seq = 0;

export function isUuidV7(value: unknown): value is string {
  return typeof value === 'string' && UUID_V7_RE.test(value);
}

export function uuidv7(nowMs: number = Date.now()): string {
  let ms = nowMs;
  if (ms <= lastMs) {
    // same (or earlier) millisecond: keep ordering by incrementing the 12-bit counter
    ms = lastMs;
    seq += 1;
    if (seq > 0xfff) {
      ms += 1;
      seq = 0;
    }
  } else {
    seq = randomBytes(2).readUInt16BE(0) & 0x7ff; // leave headroom so the counter rarely overflows
  }
  lastMs = ms;

  const b = Buffer.alloc(16);
  b.writeUIntBE(ms, 0, 6);
  randomBytes(8).copy(b, 8);
  b[6] = 0x70 | (seq >> 8);
  b[7] = seq & 0xff;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;

  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
