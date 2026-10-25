// Shared synthetic-pak builder for web tests (mirrors q2-cook format).
import { ingestPak, pakHasMaps } from './pak.js';

export { ingestPak, pakHasMaps };

/** Minimal synthetic PACK with one .bsp so pakHasMaps() is true. */
export function makePakForTest(): ArrayBuffer {
  const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const name = 'maps/devroom.bsp';
  const dirOffset = 12 + payload.length;
  const buf = new ArrayBuffer(dirOffset + 64);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  bytes[0] = 0x50; bytes[1] = 0x41; bytes[2] = 0x43; bytes[3] = 0x4b;
  view.setUint32(4, dirOffset, true);
  view.setUint32(8, 64, true);
  bytes.set(payload, 12);
  for (let k = 0; k < name.length; k++) bytes[dirOffset + k] = name.charCodeAt(k);
  view.setUint32(dirOffset + 56, 12, true);
  view.setUint32(dirOffset + 60, payload.length, true);
  return buf;
}
