# @q2/server

In-process authoritative world simulation: `SV_` world state, entity spawning, 10 Hz tick. Ports id's `server/sv_*.c` (spawning, linking, tick) on top of `@q2/game` movers/triggers.

## Public API

Entry point: `src/index.ts`.

- `ServerState` (`src/index.ts:22`) — `{ time, entities, movers, triggers, firedThisTick }`. `time` is `level.time` seconds, never wall-clock.
- `SV_Init()` (`:32`) — fresh empty world.
- `SV_LinkEdict(st, e)` (`:37`) — register an edict (`SV_LinkEdict`).
- `SV_SpawnMover / SV_SpawnTrigger` (`:41`, `:46`) — register a mover / trigger alongside its edict.
- `SV_SpawnEntities(st, text, modelSizes?)` (`:61`) — parse aQuake entities lump; wires `func_door`/`func_plat`/`func_button`/`trigger_once`/`trigger_multiple`, keeps the rest as plain edicts. Optional `modelSizes` callback gives id-correct door travel from BSP brush bounds (else `distance` default 128).
- `SV_UseTargetname(st, targetname)` (`:110`) — fire `moverUse` on every mover with that targetname (button/trigger path).
- `fireTargets(st, user)` (`:122`) — `G_UseTargets` equivalent: use everything `user.target` points at; records `firedThisTick`.
- `SV_TouchTriggersAt(st, toucherClass, toucher)` (`:133`) — point-in-radius touch test hook (drives `triggerTouch`).
- `SV_Tick(st, dt = SERVER_DT)` (`:157`) — advance `time` by `dt` (0.1 s, 10 Hz) and run movers to completion legs.

## How it is used

Consumed by `@q2/host`, which owns the frame loop and calls `SV_Tick` at 10 Hz. Nothing else imports it.

```ts
import { SV_Init, SV_SpawnEntities, SV_Tick, SV_UseTargetname } from '@q2/server';
const st = SV_Init();
SV_SpawnEntities(st, mapEntitiesText);
SV_UseTargetname(st, 'door1');
for (let i = 0; i < 20; i++) SV_Tick(st); // door leg completes
```

## Testing

`yarn workspace @q2/server test` (vitest).

- `src/server.test.ts` — tick advances `level.time` by 0.1; scripted `BASE1_LOGIC` entities-lump fixture (inline string, `:14`) drives button → door and `trigger_once` touch.
- `src/base1.test.ts` — asset-gated WIRE integration (`describe.runIf(!!Q2_PAK)`): loads real `maps/base1.bsp` from `Q2_PAK`, asserts entity counts (600+ edicts, 4 doors, 22 triggers), spawn-drop landing, wall blocking, and a scripted bot traversal. Skips without `Q2_PAK`; never commits asset bytes.

## Constraints

- Dependency direction (BRAIN.md repo layout): `server` may depend on `@q2/game`/`@q2/bsp` (plus `@q2/config`, `@q2/filesystem`, `@q2/math` per `package.json`); only `@q2/host` may depend on it.
- Platform: DOM-free pure logic. `src/node-shim.d.ts` exists only so the asset-gated tests can use `fs`/`process` under Node.
