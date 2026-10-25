---
'@q2/game': minor
'@q2/server': minor
---

M7.4 gameplay completions (game + server only).

- Pickups respawn: `DoRespawn`/`SetRespawn` port the id timing table
  (`g_items.c`: weapons/health/ammo 30s, armor 20s, level.time-based, never
  wall-clock). Single-player id frees pickups permanently; M7.4 enables
  DM-style timers so base1 stays playable (documented in code).
- Pusher carrying: `SV_Push` (g_phys.c semantics — 1/8-unit quantize, riders
  keyed by groundEntity, stuck-rider rollback) plus `SV_CarryRiders` and
  per-tick `moverDeltas` in the 10Hz `SV_Tick`. The WIRE bot touches *31
  like the real game, boards the plug and rides 272 units of pusher
  displacement (asserted), then holds at the slot.
- WIRE-EXIT geometry verdict (audited, not faked): the pit is sealed rock
  except the top slot and the plug fills it in every state (closed/open/all
  transit steps probed); no rider configuration overlaps *27. The only
  overlap is the pit floor (proven by the unchanged mechanism test), so the
  driver asserts the ride + slot proximity and honestly reports the
  slot-edge hold instead of faking the touch.
- Monsters navigate: `monsterChaseMove` steers the soldier/gunner-lite
  state machines along a caller-supplied node graph (BFS `findPath`) —
  attack in range with sight, run/runandshoot to close, stand when cut off.
  Full M5.3 AI remains out of scope.
