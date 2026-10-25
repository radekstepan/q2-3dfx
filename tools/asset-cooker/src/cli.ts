#!/usr/bin/env node
// q2-cook CLI: pak0.pak → .q2pkg (deflate, per-map split).
// Node-only entry point; the library (./index.js) stays importable anywhere.
import { cookPak, splitPak } from './index.js';

function defaultOutput(input: string): string {
  return /\.pak$/i.test(input) ? input.replace(/\.pak$/i, '.q2pkg') : `${input}.q2pkg`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length < 1 || argv[0] === '--help' || argv[0] === '-h') {
    console.log('usage: q2-cook <in.pak> [out.q2pkg]');
    console.log('  out defaults to <in> with the extension swapped to .q2pkg');
    process.exit(argv.length < 1 ? 1 : 0);
  }
  const input = argv[0] as string;
  const output = argv[1] ?? defaultOutput(input);
  const fs = await import('fs');
  // Copy out of the Buffer pool: Buffer#buffer may be a larger pooled slab.
  const raw = fs.readFileSync(input);
  const pakBuf = new ArrayBuffer(raw.length);
  new Uint8Array(pakBuf).set(raw);
  const t0 = Date.now();
  const cooked = await cookPak(pakBuf);
  fs.writeFileSync(output, cooked);
  const files = splitPak(pakBuf).length;
  console.log(
    `cooked ${files} files: ${(pakBuf.byteLength / 1048576).toFixed(2)}MB -> ` +
      `${(cooked.length / 1048576).toFixed(2)}MB in ${Date.now() - t0}ms -> ${output}`,
  );
}

void main();
