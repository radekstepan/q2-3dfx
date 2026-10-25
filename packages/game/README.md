# @q2/game

`gamex86` port: entities, player physics, items, movers, monsters, weapons (M5.x).
Ports `qcommon/pmove.c`, `g_spawn.c`/`G_Spawn`, `g_items.c`, `p_*/m_*` into headless,
deterministic TypeScript (`src/index.ts:1`).

Entry point: `src/index.ts` (pure re-export barrel).

## Public API

- pmove (`src/pmove.ts`, re-exported `src/index.ts:2-44`): `pmove(st, cmd)` / `pmoveFull(st, cmd)` (`pmove.ts:630,659`) — one usercmd step, dt only from `cmd.msec`; `PM_StepSlideMove` (`:330`), `PM_ClipVelocity` (`:154`), `PM_Friction`/`PM_Accelerate`/`PM_AirAccelerate`, `PM_CategorizePosition`, `PM_CheckDuck/Jump/SpecialMovement`; `makePmoveState` (`:111`), `setPmoveWorld(trace, contents)` (`:101`) world-hook injection; types `UserCmd`, `PmoveState`, `TraceFn` (`index.ts:44`).
- entities (`index.ts:45-64`, ports `g_spawn.c`): `parseEntities`, `spawnEdict`, `freeEdict`, `findByTargetname/Classname`, `useTargets`; `SOLID_*`, `MOVETYPE_*`.
- items (`index.ts:65`): `findItem`, `makePlayerState`, `pickupItem`, `MAX_HEALTH`.
- func (`index.ts:67-86`): `spawnDoor/Plat/Button`, `moverUse/moverThink`, `spawnTrigger`, `triggerTouch`, `teleportTo`; `MOVER_*`, `DOOR_*`.
- weapons (`index.ts:87-99`, `g_weapon.c`): `findWeapon`, `fireWeapon`, `mulberry32`, `WEAPON_*`, `DEFAULT_*SPREAD/COUNT`.
- monsters (`index.ts:101-117`): `monsterDef/spawnMonster/monsterThink/monsterPain/selectAttack`, `SOLDIER`, `GUNNER`, `RANGE_*`.
- `findPath`, `isReachable` (`index.ts:118`); collision hookup `bspTraceFor`, `setPmoveWorldFromBsp`, `MASK_PLAYERSOLID` (`index.ts:120-131`).

## How it is used

Consumed by `@q2/server` (`src/index.ts:19-20`, `server.test.ts:3`) for world state and tick.

```ts
import { makePmoveState, setPmoveWorld, pmove } from '@q2/game';
const st = makePmoveState();
setPmoveWorld(traceFn, contentsFn); // else empty-world defaults
pmove(st, { msec: 100, angles: v3(), forwardmove: 400, sidemove: 0, upmove: 0, buttons: 0 });
```

## Testing

- `yarn workspace @q2/game test` — `src/pmove.test.ts`, `src/entities.test.ts`, `src/weapons.test.ts` (movement determinism, entity lump parsing, weapon spreads).

## Constraints

- Dependency direction (BRAIN.md §4): `game ← {math, bsp, config}`; `server ← game`. Never import `apps/*`, renderer, or client packages.
- Platform: headless and deterministic — no wall-clock in game logic (server ticks 10 Hz), no `Math.random` in `pmove.ts:1-4` (weapons use seeded `mulberry32`); DOM-free, Node and worker safe.
