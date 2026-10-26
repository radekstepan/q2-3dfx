---
"@q2/input": patch
"@q2/client": patch
"@q2/host": patch
---

fix(input,client,host): stop jitter, crouch bind c (M5.1)

Stop jitter root cause: the predictor replayed the whole staged cmd stream
regardless of sub-tick render time (a full frame ahead of the snapshot at
tick instants, snapping back each tick), and prefix replays overshoot the
full 100ms friction step they prefix (friction decay is front-loaded in a
single pmove step — shorter dt keeps more velocity). `CL_Predict` now
replays the staged stream as the tick-end target (friction-exact,
bit-identical to the server's 100ms step) and blends snapshot→target by
the sub-tick debt, so renders are tick-exact, monotonic, and never
overshoot. `CL_PredictPmove` gains an optional `horizonMs` budget (the
zero-velocity snap now considers only the horizon-trimmed prefix). New
headless settle tests pin monotonic constant-velocity stops, tick-exact
10Hz agreement, and the ducked variant. 10Hz sim untouched.

Crouch: new `crouch`/`duck` `LogicalKey` aliases bound to `KeyC` in
`dom.ts` (`ControlLeft` stays swim-down). Holding either sets the new
`BUTTON_DUCK` bit (8, `BUTTON_CROUCH` alias; `isDuckHeld(cmd)` reads it),
which flows Host→driver→`pmoveFull` untouched. `@q2/game`'s `PM_CheckDuck`
does not consume the bit yet (GAME CHANGE NEEDED, reported not edited):
drivers translate via `isDuckHeld(cmd)` → `PMF_DUCKED` (ducked hull
`mins.z -24 / maxs.z 4 / viewheight 12`, speed clamped to `PM_DUCKSPEED`),
pinned by unit + ducked-settle tests.
