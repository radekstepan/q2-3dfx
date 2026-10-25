# @q2/filesystem

PAK reader and lump lookup. Ports `qcommon/files.c` (`FS_LoadPackFile`): a
`.pak` is a flat archive with a 12-byte header at offset 0 and the
directory at the tail; lumps are stored uncompressed.

## Public API

Entry point: `src/index.ts`. Errors via `Com_Error` from `@q2/config`.

- `normalizePath(p)` — lowercase, backslash→slash, strip leading slashes (`src/index.ts:35`).
- `parsePakDirectory(buf): PakEntry[]` — parse the tail directory; `buf` must hold header + directory, is not copied (`src/index.ts:53`).
- `parsePak(buf): Pak` — buffer plus parsed directory (`src/index.ts:82`).
- `readPakFile(pak, name): ArrayBuffer` — case-insensitive lump read; returns a copy so the pak buffer can be released (`src/index.ts:90`).
- `PakFile` — indexed owner of a parsed buffer for repeated lookups (`has` / `readFile`); `readPakFile` stays for one-offs (`src/index.ts:103`).
- Constants: `PAK_IDENT` (`"PACK"` LE), `PAK_ENTRY_SIZE` (64), `PAK_MAX_FILES` (4096) (`src/index.ts:10`).

## Usage

Consumed by `@q2/formats` (dep edge `filesystem ← formats`), `@q2/server`
and `@q2/testkit` (real-map loads), and the web app's pak drop ingest.
IndexedDB caching is planned (see header comment) but not in `src` yet.

```ts
import { PakFile } from '@q2/filesystem';
const pak = new PakFile(await pak0.arrayBuffer());
if (pak.has('MAPS/BASE1.BSP')) {
  const bspBytes = pak.readFile('maps/base1.bsp'); // normalised lookup
}
```

## Testing

```bash
yarn workspace @q2/filesystem test
```

`src/index.test.ts` builds minimal in-memory paks and checks directory
parse, normalised lookup, and corrupt-header rejection; real-`pak0.pak`
cases (`Q2_PAK` env, e.g. 3307-entry round-trip) run in nightly only.
`src/node-shim.d.ts` types the test-only `fs` import.

## Constraints

Dependency direction (BRAIN.md §4): may depend only on `@q2/config` (it
does: `package.json`). Must not import `formats`, `math`, `bsp`, or
anything upstream. No DOM/IndexedDB calls in `src` today — pure
`ArrayBuffer`/`DataView` parsing, runs in browser, worker, and Node.
