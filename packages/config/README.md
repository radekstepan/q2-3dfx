# @q2/config

Cvars, Voodoo fidelity switches, build-time constants, and `Com_Error` —
the `qcommon/` equivalent (BRAIN.md §5). Bottom of the dependency graph:
every package may import it, it may import nothing.

## Public API

Entry point: `src/index.ts`.

- `LUXEL / SERVER_HZ / SERVER_DT / MAX_LIGHTSTYLES` — shared constants; server ticks at 10 Hz (`src/index.ts:3`).
- `ComError / Com_Error(level, msg)` — id-style fatal/panic; never raw `throw` in engine code (`src/index.ts:10`).
- `Com_Warn / Com_Printf` — warn/prefixed console logging (`src/index.ts:23`).
- `registerCVar / getCVar / getCVarNumber / getCVarString / getCVarBool / setCVar / setCVarFromString / listCVars / resetCVars` — cvar registry; `setCVarFromString` coerces numbers/booleans from console text (`src/index.ts:83`).
- `features / FeatureName / featureEnabled` — prime-directive flags (`workers`, `wasmSpans`, `voodoo`); land risky work behind a flag (`src/index.ts:131`).
- Default cvars: `vd_*` Voodoo switches (dither, bilinear, fog, gamma, …), `sw_gamma`, `r_drawworld`, `cl_predict/cl_interp`, `s_volume`, `sensitivity/m_yaw/m_pitch`, `vid_renderer` (`src/index.ts:40`).

## Usage

Consumed by every package (cvar reads in `@q2/voodoo`, `@q2/input`,
`@q2/client` console, `SERVER_DT` in `@q2/host`/`@q2/server`, error
handling everywhere).

```ts
import { getCVarNumber, setCVar, featureEnabled, Com_Error } from '@q2/config';
setCVar('vd_gamma', 1.3);
const gamma = getCVarNumber('vd_gamma');
if (!featureEnabled('voodoo')) Com_Error('drop', 'voodoo path disabled');
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
