# @q2/client

Client-side frame logic: prediction, interpolation, view, HUD, console. Ports id's `client/cl_*.c` (`CL_Predict`, `CL_Interpolate`, statusbar layout exec, console) as DOM-free pure modules.

## Public API

Entry point: `src/index.ts` (re-exports `prediction.ts`, `hud.ts`, `statusbar.ts`, `console.ts`).

- Prediction (`src/prediction.ts`): `CL_Predict(newest, localId, dt, cmds?)` (`:86`) — owned-cmd replay through the real `pmoveFull` step from `@q2/game` when `cmds` are staged and `cl_predict` is nonzero, else constant-velocity extrapolation (A/B baseline); `CL_PredictPmove(base, localId, cmds)` — the raw pmove replay; `Predictor` (`:93`, keeps last two snapshots, overrides self with prediction, `setPendingCmds`/`clearPendingCmds` stage the unacked stream); `CL_Interpolate(prev, next, renderTime)` (`:63`) — lerp entities present in both snapshots, hold the rest (untouched by the pmove hookup); `interpFraction` (`:44`), `renderTimeFor` (`:50`), `extrapolateOrigin`/`lerpOrigin`/`clamp01`, types `Origin3`, `EntityState`, `Snapshot`, `InterpolatedEntity`, `PredictCmd`.
- HUD (`src/hud.ts`): `makeConcharsFont` (`:17`) — deterministic procedural 8x8 font so text works without `pics/conchars.pcx`; `set/getConcharsFont`, `drawChar` (`:65`), `drawString` (`:88`), `stringWidth`, `fillRect` (`:109`); constants `GLYPH_W`/`GLYPH_H` (`:9`), `CONCHARS_COUNT` (`:11`); types `ConcharsFont`, `BlitSurface`.
- Statusbar (`src/statusbar.ts`): `CS_STATUSBAR = 5` (`:8`); `tokenizeLayout` (`:29`), `parseStatusbar` (`:65`) — layout script → `StatusOp[]`; `Configstrings` (`:124`) with `.statusbar()` parsing the `CS_STATUSBAR` slot.
- Console (`src/console.ts`): `GameConsole` (`:32`) — `print`/`toggle`/`exec` with `help echo clear list get set toggle` wired to `@q2/config` cvars; `CONSOLE_MAX_LINES = 256` (`:5`).
- `VIEW_HEIGHT = 22` (`src/index.ts:31`), `calcViewOrigin(origin)` (`:34`) — camera origin 22 units above the predicted player origin.

## How it is used

Consumed by `@q2/host`, which feeds server snapshots into `Predictor` and draws the HUD/console via `hud.ts` onto a `Framebuffer`. Nothing else imports it.

```ts
import { Predictor, CL_Predict, GameConsole, parseStatusbar } from '@q2/client';
const p = new Predictor();
p.pushSnapshot(snap);                       // 10 Hz server sample
const ents = p.renderEntities(now, localId); // interpolated remotes + predicted self
const con = new GameConsole();
con.exec('set cl_predict 1');
```

## Testing

`yarn workspace @q2/client test` (vitest). Four suites, all headless unit tests, no fixtures or goldens: `prediction.test.ts` (interp math), `console.test.ts` (cvar wiring), `hud.test.ts` (conchars blits), `statusbar.test.ts` (layout parsing).

## Constraints

- Dependency direction: `client` may depend on `@q2/renderer-api`, `@q2/input`, `@q2/sound`, `@q2/config`, `@q2/game` (headless `pmoveFull` step for prediction only — no world sim, no rendering); only `@q2/host` may depend on it.
- Platform: DOM-free. HUD blits into a `Framebuffer | BlitSurface` (`src/hud.ts:60`); the web shell owns all DOM/canvas work.
