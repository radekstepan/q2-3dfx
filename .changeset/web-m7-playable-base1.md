---
"web": minor
---

feat(web): playable base1 — monster combat, pickups, view model, per-channel sound (M7.2)

Apps/web only (plus existing @q2/game/@q2/server/@q2/sound exports, no contract changes):

- Monsters fight back: per-tick `monsterThink` plus `selectAttack` tracers
  (melee 10/15 dmg, ranged 5/6/12 with range falloff and BSP line-of-sight),
  ~1/s per-monster rate limit, player health/death + 2s respawn at the
  untargeted `info_player_start` (id `SelectSpawnPoint` rule: base1's lump
  leads with a targeted "base2" start that must be skipped).
- Pickups: walk-over `item_*`/`weapon_*`/`ammo_*` edicts grant via
  `pickupItem` (shotgun/machinegun unlock + auto-select, finite ammo);
  unowned weapons refuse to select.
- Weapon view model: bottom-right gun silhouette per weapon + muzzle-flash
  glow in `drawPlayHud`, plus a real renderer dlight pumped through
  `pumpMuzzleLight()` before each frame.
- Per-channel sound: `LocalDriver` owns a headless `Mixer` (shots, monster
  fire, pickups, door/button moves, pain/death, 1s one-shot expiry);
  `syncMixerToBrowser()` drives `GainNode`/`StereoPannerNode` per channel
  from `mix()` gains instead of one-shot cues.
- Driver actually opens doors (`checkDoorTouch`, Touch_DoorTrigger volumes)
  and fires brush triggers (`checkBrushTriggers`, real AABB overlap) — the
  *27 pit volume now reaches `t37`/changelevel in real play.

Tests: headless devroom death/respawn + HUD gun pixels + muzzle dlight +
mixer attenuation; Q2_PAK scripted run (damage → pain channel, shotgun
pickup, soldier kill removed from snapshot, pit exit fires t37).
