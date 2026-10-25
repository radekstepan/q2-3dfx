# @q2/input

Keyboard/mouse/gamepad → `usercmd_t` (`client/cl_input.c`).

## What it is

Headless core (`index.ts`): `InputCore` accumulation plus pure
`buildUserCmd` (mouse deltas, 140°/s turn keys, WASD ±400, analog stick,
button bits). Browser bindings (`dom.ts`, `@q2/input/dom` subpath):
`attachToCanvas(canvas, target?)` for WASD/arrows/Space/E, pointer-lock
mouse look, mouse-button attack/use, with `dispose()`; `pollBrowserGamepads`
for pads. Importing `dom.ts` in Node is a safe no-op.

`attachToCanvas` uses a caller-supplied core when given (e.g. the shared
`Host.input`), otherwise creates its own.

## Public API (`src/index.ts`, `src/dom.ts`)

- `UserCmdT { msec, angles, forwardmove, sidemove, upmove, buttons }`,
  `BUTTON_ATTACK/BUTTON_USE/BUTTON_JUMP`, `LogicalKey` union.
- `createInput / keyDown / keyUp / mouseMove / applyGamepad / buildUserCmd`.
- `attachToCanvas(canvas, target?): DomBindings { input, dispose }`.
- Jump maps to `upmove +400` (what `pmove`'s `PM_CheckJump` requires).

## How it is used

`@q2/host` builds one cmd per frame from its `input`; `apps/web` binds that
same core to the canvas. Tests drive `keyDown`/`mouseMove` directly.

## Testing

`yarn workspace @q2/input test` — key mapping, mouse deltas, gamepad
dead-zone, legacy adapter, dom target-sharing/no-op.

## Constraints

Headless-safe, no DOM at import time. Only depends on `@q2/config`
(sensitivity cvars). Exposes `./dom` as a separate export so Node entry
stays pure.
