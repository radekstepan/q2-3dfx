# @q2/formats

Asset parsers (WAL, PCX, SP2, WAV implemented; BSP38/MD2 stubbed) producing
plain typed arrays. Ports `qcommon/qfiles.h` structs, `ref_soft/r_image.c`
(`LoadPCX`, `R_LoadWal`), and `client/snd_mem.c` (`GetWavinfo`).

## Public API

Entry point: `src/index.ts`. Errors via `Com_Error` from `@q2/config`.

- `parseWAL(buf): Wal` — `miptex_t`: 4 mip levels of palette indices, dims `(w>>k, h>>k)` (`src/index.ts:93`).
- `parsePCX(buf): Pcx` — 8-bit RLE PCX → pixels + trailing 768-byte palette (`src/index.ts:135`).
- `extractColormap(pcx) / buildColormap(palette)` — first 16384 px of `colormap.pcx` as the 64×256 shade table, or a best-match fallback from the palette (`src/index.ts:200`).
- `parseSP2(buf): Sp2` — `dsprite_t`: flat `Int32Array` lump data + art names (`src/index.ts:261`).
- `parseWavHeader(buf): WavInfo` — header facts only (rate/width/channels/samples/loopstart/dataOffset); sample bytes stay in the caller buffer (`src/index.ts:293`).
- `parseBSP38 / parseMD2` — **stubs**: currently `Com_Error('fatal', 'not implemented')` (`src/index.ts:66`). The full BSP loader lives in `@q2/bsp` (`loadBsp`); see its report note about extending the `Bsp38` contract.
- Constants: `WAL_HEADER_SIZE / WAL_MIP_LEVELS`, `PCX_*` magic/sizes, `COLORMAP_*` dims, `SP2_IDENT / SP2_VERSION / SP2_FRAME_SIZE` (`src/index.ts:85`).

## Usage

Consumed by `@q2/bsp` (the `Bsp38` structural type), `@q2/sw-renderer`,
`@q2/testkit`, and real-pak integration in `@q2/server` tests.

```ts
import { PakFile } from '@q2/filesystem';
import { parseWAL, parsePCX, extractColormap } from '@q2/formats';
const wal = parseWAL(pak.readFile('textures/e1u1/floor1_3.wal'));
const diffuse = wal.mips[0]; // Uint8Array, w*h palette indices
const table = extractColormap(parsePCX(pak.readFile('pics/colormap.pcx')));
```

## Testing

```bash
yarn workspace @q2/formats test
```

`src/index.test.ts` builds synthetic WAL/PCX/SP2/WAV buffers in-code and
byte-checks the parse; real-`pak0.pak` cases (`Q2_PAK` env) run in nightly
only and skip otherwise. `src/node-shim.d.ts` types the test-only `fs` import.

## Constraints

Dependency direction (BRAIN.md §4): may depend on `config`, `filesystem`,
`math` (it does: `package.json`). Must not import `bsp` or anything
upstream (`bsp` imports *its* `Bsp38` type — keep that direction). DOM-free;
`TextDecoder` only. Runs in browser, worker, and Node.
