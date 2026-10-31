# @q2/config

Cvars, `vd_*` appearance switches (WebGL live-uniforms; the legacy CPU Voodoo
execution mode was retired under RELEASE-8), build-time constants, and
`Com_Error` — the `qcommon/` equivalent (BRAIN.md §5). Bottom of the
dependency graph: every package may import it, it may import nothing.

## Public API

Entry point: `src/index.ts`. Selection vocabulary lives here (`VidRendererId`,
`describeRendererSelection`, `isKnownRendererId`) and in `@q2/renderer-api`
(`ResolvedBackend`, `resolveRendererSelection`), mirrored by value; RELEASE-8
removed `voodoo` from both (persisted `voodoo` → `software` with a warning).

- `LUXEL / SERVER_HZ / SERVER_DT / MAX_LIGHTSTYLES` — shared constants; server ticks at 10 Hz (`src/index.ts:3`).
- `ComError / Com_Error(level, msg)` — id-style fatal/panic; never raw `throw` in engine code (`src/index.ts:10`).
- `Com_Warn / Com_Printf` — warn/prefixed console logging (`src/index.ts:23`).
- `registerCVar / getCVar / getCVarNumber / getCVarString / getCVarBool / setCVar / setCVarFromString / listCVars / resetCVars` — cvar registry; `setCVarFromString` coerces numbers/booleans from console text (`src/index.ts:83`).
- `features / FeatureName / featureEnabled` — prime-directive flags (`workers`, `wasmSpans`); land risky work behind a flag (`src/index.ts:131`). The legacy `voodoo` flag was removed under RELEASE-8.
- Default cvars: `vd_*` appearance switches (dither, bilinear, fog, gamma, …; WebGL live-uniforms), `sw_gamma`, `r_drawworld`, `cl_predict/cl_interp`, `s_volume`, `sensitivity/m_yaw/m_pitch`, `vid_renderer` (`software | webgl2-experimental`; persisted legacy `voodoo` migrates one-time to `software` with a warning) (`src/index.ts:40`).

## Usage

Consumed by every package (cvar reads in `@q2/voodoo`, `@q2/input`,
`@q2/client` console, `SERVER_DT` in `@q2/host`/`@q2/server`, error
handling everywhere).

```ts
import { getCVarNumber, setCVar, featureEnabled, Com_Error } from '@q2/config';
setCVar('vd_gamma', 1.3);
const gamma = getCVarNumber('vd_gamma');
if (!featureEnabled('workers')) Com_Error('drop', 'worker path disabled');
```

## Testing

```bash
yarn workspace @q2/config test
```

`src/cvars.test.ts` checks defaults, type coercion, and first-registration-wins.
No fixtures or goldens. `resetCVars()` restores defaults between tests.

## Constraints

Dependency direction (BRAIN.md §4): `@q2/config` must have **no** workspace
dependencies (it has none). Platform-free: only `console` I/O, no DOM, no
Node APIs, safe in renderers, workers, and headless tests.
