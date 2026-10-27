---
'@q2/server': minor
---

Phase 0 single authoritative sim (BRAIN.md §15): the server owns all base1 gameplay state at 10Hz — monsters (C-cadence think/fire resolution), barrels (misc_explobox + func_explosive with damage/delay/damageRadius), bolts (player + foe blaster edicts with wall/flesh touch), explosions + muzzle/tracer/spark/sound event feeds, debris/gibs, scripted target_explosions, the player health pool, and monster door touches. New: SV_PlayerFire (shot application/damage), SV_Tick gameplay phase, SV_TraceFor/SV_DropTraceFor C-mask helpers, SV_SpawnMonster/SV_AddBarrel test hooks, server event drains. The web driver renders from server state and forwards fire via SV_PlayerFire; its private PlacedMonster/barrel/bolt sims and driver door touch are deleted, and every driver trace goes through the server C-mask helpers. Adds a Phase 0 driver-level base1 bot gate (barrels die, monster closes, door re-closes, secret holds, TTK ≤ 4).
