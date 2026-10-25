# asset-cooker

`pak0.pak` → `.q2pkg` converter (single deflate-compressed binary, per-map split). No id Quake II source port — new build-time tool; the `.q2pkg` layout is defined in `src/index.ts:3-9`.

## Public API

Library entry point: `src/index.ts`. CLI entry point: `src/cli.ts` (bin `q2-cook`, see `package.json` `bin` + `tsup.config.ts` dual entry).

- `Q2PKG_MAGIC = 'Q2PKG1'` (`src/index.ts:15`); `Q2PkgEntry` (`:18`), `CookedPkg` (`:23`), `PakFile { name, data }` (`:29`).
- `splitPak(buf)` (`:45`) — parse a PAK buffer into named files (local reader mirroring `@q2/filesystem`; names lower-cased).
- `cookPak(pakBuf)` (`:65`) — deflate each file, emit the `.q2pkg` image (header + concatenated streams).
- `readQ2Pkg(buf)` (`:102`) — read the index; payload stays compressed until extracted.
- `extractEntry(pkg, name)` (`:129`) — inflate one entry (case-insensitive); throws on size mismatch.
- `makeSyntheticPak(files)` (`:140`) — build a small synthetic pak for tests/smoke runs.
- `createDeflate / createInflate` (`src/codec.ts:2`, `:7`) — `node:zlib` wrappers, lazily imported so the library stays importable anywhere.
- CLI (`src/cli.ts`): `q2-cook <in.pak> [out.q2pkg]` (`:10`); prints `cooked N files: A MB -> B MB in Tms -> out`.

## How it is used

Used by humans via `yarn cook ~/q2/pak0.pak` (root `package.json` script → `q2-cook` bin); `@q2/filesystem` caches the cooked blobs client-side in IndexedDB. Cooked assets are never committed.

```ts
import { cookPak, readQ2Pkg, extractEntry } from 'asset-cooker';
const cooked = await cookPak(pakBuf);
const base1 = await extractEntry(readQ2Pkg(cooked), 'maps/base1.bsp');
```

```sh
q2-cook pak0.pak          # -> pak0.q2pkg
```

## Testing

`yarn workspace asset-cooker test` (vitest).

- `src/cooker.test.ts` — synthetic round-trip via `makeSyntheticPak` (`:4`): split names, `cook → read → extract` byte-identity, deflate actually shrinks redundant data, bad-magic rejection on both ends.
- Asset-gated: with `Q2_PAK` set, cooks the full shareware pak (expects 3307 entries) and reads `maps/base1.bsp` back byte-identical (`:47`). Skips without `Q2_PAK`.

## Constraints

- Dependency direction: `tools/*` are leaves — nothing depends on them. May depend on `@q2/config`, `@q2/filesystem`, `@q2/formats` (per `package.json`).
- Platform: library is importable anywhere (Node imports lazy); the CLI (`src/cli.ts`, `fs` + `process.argv`) is Node-only.
