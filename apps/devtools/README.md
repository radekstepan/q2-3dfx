# devtools

Map/BSP inspector, lightmap viewer, frame differ app. No id Quake II source port — new tooling over `@q2/bsp` + `@q2/formats`.

## Public API

Entry point: `src/index.ts`. Currently graceful stubs until the `@q2/bsp` + `@q2/formats` backends land — every probe reports `{ ok: false }` instead of throwing.

- `ProbeResult<T>` (`src/index.ts:4`) — `{ ok, reason?, value? }` envelope.
- `probeBsp(buf)` (`:10`) — stub; reports `{ ok: false, reason: 'parseBSP38 not implemented yet (M2.1 owns it)' }`.
- `diffFrames(a, b)` (`:15`) — byte-compare two frames, returns differing pixel count (length mismatch returns the larger length).
- M4.1 human review (`src/sidebyside.ts`, dependency-free): `summarizeReview(name, actual, reference)` (§10.3 tolerance), `reviewLine`, `reviewReportHtml` (standalone verdict document), `captureChecklist()` (short form of `packages/testkit/CAPTURE-M4.1.md`).
- `hexDump(bytes, max = 64)` (`:22`) — compact hex dump for lump inspection.

## How it is used

Standalone app (`private: true`); per repo layout nothing imports from `apps/*`. Opened directly as a page/CLI aid alongside the game.

```ts
import { probeBsp, diffFrames } from 'devtools';
const probe = probeBsp(bspBytes);
if (!probe.ok) console.log(probe.reason);
console.log('differing pixels:', diffFrames(frameA, frameB));
```

## Testing

`yarn workspace devtools test` (vitest). `src/sidebyside.test.ts`: M4.1 review
summaries (tolerance boundaries, missing-reference pending, HTML report,
checklist). No test files, fixtures, or goldens exist yet for the BSP probes.

## Constraints

- Dependency direction: apps are leaves — nothing may import from `apps/*`. May depend on `@q2/bsp`, `@q2/config`, `@q2/formats` (per `package.json`).
- Platform: platform-free today (`src/index.ts` touches no DOM or Node APIs).
