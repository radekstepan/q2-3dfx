---
'@q2/game': minor
---

Fix the spurious base1 exit fire at the game-logic layer: `triggerTouch` now implements the exact id `Touch_Multi` gate (players fire unless `NOT_PLAYER`/spawnflag 2; monsters fire only with `MONSTER`/spawnflag 1; anything else never fires — the old code let monsters fire without the bit). Add the pure, headless-testable `monsterLocomotion(state, origin, playerPos, trace)` tick (yaw toward the player, advance by the current frame's `dist`, collision-clamped via an origin-space trace over the `MONSTER_HULL_MINS/MAXS` hull, gravity drop that sticks to floors/step-downs and falls bounded by `MONSTER_FALL_PROBE`); `monsterThink` keeps working single-arg. Tests: touch-gate units + 7 locomotion tests (stub traces).
---
'@q2/server': minor
---

Fix the spurious base1 exit fire (live "LEVEL COMPLETE" near spawn + `exited`-gated invincibility shared one root cause): `SV_TouchTriggersAt` tested brush triggers with a 96-unit point check around the edict origin, which defaults to the world origin (0,0,0) — walkable floor in base1, so every brush trigger (incl. the *27 exit pit -> t37 chain) fired near spawn. Brush triggers are now tested by real brush-VOLUME overlap via a new `triggerBounds` map (populated from the `modelSizes` hook, same pattern as `moverBounds`); volume-less brush triggers never fire from the point hook, point triggers keep the legacy check. Also id-exact target firing: `SV_UseMover` fires func_door targets at use time (`door_go_up`), `SV_Tick` fires func_button targets on top arrival (`button_wait`), and `fireTargets` cascades through `trigger_relay` (depth-guarded cycle cap). Verified on real pak0.pak: only *27 targets t37, no relay/mover path can fire it. Tests: spawn-walk + relay-audit regression in base1.test.ts, volume/relay/mover units in server.test.ts.
