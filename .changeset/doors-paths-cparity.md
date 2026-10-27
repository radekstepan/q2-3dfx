---
"@q2/server": patch
---

feat(server): doors/paths C-parity — secret, rotating, CalcMoveSpeed, train_find

- `func_door_secret` (new `doors.ts`): SP geometry from brush bounds
  (back-out along +/-right or -up, slide along forward), the C 5-phase chain
  (back, 1s pause, slide, hold `wait`, return via pos1, 1s pause, close) at
  the C-forced 50 u/s, re-fire gated on fully-closed-at-rest (C
  `door_secret_use` origin compare), shoot-to-open (`die` runs `use`) for
  untargeted / `SECRET_ALWAYS_SHOOT` doors, blocked damage with the C 0.5s
  debounce (100000 crush + free for debris). C plays no sounds on this
  chain — silence is faithful.
- `func_door_rotating` (new `doors.ts`): axis from `DOOR_X_AXIS`/`DOOR_Y_AXIS`
  (else Z), `DOOR_REVERSE` negation, default 90-degree swing, mapper angles
  cleared, `START_OPEN` swap, angular travel via `door_go_up`/`door_go_down`
  with `G_UseTargets` + start/end sounds on opening legs, `TOGGLE`
  close-from-top, `TOP` wait reset, `door_blocked` damage with reverse
  (never for `CRUSHER` / negative `wait`). Touch opens via
  `SV_TouchDoorsAt` (rest bounds + 60u slop, `NOMONSTER` gated); secrets
  spawn no touch trigger, like C.
- `Think_CalcMoveSpeed`: team-keyed movers share one travel time (shortest
  move governs) at `SV_SpawnEntities` time; single movers are the identity.
- `func_train_find` generalization: `TRAIN_TOGGLE` pause-mid-leg / resume
  (`train_resume`), `wait<0` halt (dead without `TOGGLE`, resumable with
  it), `train_blocked` damage rules (default 100, 0 with `BLOCK_STOPS`,
  0.5s debounce, 100000 crush for debris). Teleport-corner link-following
  and `wait>0`/`pathtarget` semantics already covered `func_train` via the
  shared `trainNext`/`advanceTrainSeg` path; verified by new synthetic tests.
- Proven by synthetic unit tests (`doors.test.ts`: 25, `trains.test.ts`:
  11) — base1 ships no secret/rotating doors, so C-parity here is for other
  maps + future. base1 bot green: doors still open/re-close, trains/ships
  loop (`base1-gate` c/g, `m71` DoorSync + train-brush tests green).
- Follow-ups (not this lane): blocked-damage tick wiring needs physics-push
  victim plumbing (no mover-vs-body collision exists for any mover yet);
  per-team trigger volumes (Think_SpawnDoorTrigger union) are per-mover.
