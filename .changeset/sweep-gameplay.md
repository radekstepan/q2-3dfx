---
'@q2/game': minor
'@q2/server': minor
'@q2/client': minor
---

Sweep gameplay lane: real pak sound names, corpse overkill-mince, breather/envirosuit suits, snapshot yaw lerp.

C ground truth (../external/quake-2-source): g_func.c door/button
sounds, g_items.c pickup/Use_Breather/Use_Envirosuit, g_misc.c
misc_deadsoldier_die (-80, 4x sm_meat + head2, no G_FreeEdict),
p_view.c P_WorldEffects (suit air/breath/sizzle/airout) + P_DamageFeedback
bands + player_die, client/snd_dma.c sexed-sound male fallback,
client/cl_ents.c LerpAngle via game/q_shared.c.

- Sound names: driver emits the real pak lumps (doors/dr1_strt.wav,
  switches/butn2.wav, items/pkup.wav, banded player/male/painN_M.wav,
  player/male/deathN.wav with the health<-40 udeath gib branch); server
  maps `*gurpN` to the C male fallback at emit. M7.2 assertions updated;
  new Q2_PAK test asserts every emitted channel name resolves and its wav
  header decodes.
- Corpses: bolt/pellet touch sweeps hit misc_deadsoldier hulls
  (nearest-wins, live edicts win ties); SV_DamageDeadsoldier minces past
  -80 through the shared gib pipeline (corpse persists, re-gibs — no
  G_FreeEdict, like C); driver surfaces 'gib' per mince.
- Suits: item_breather/item_enviro defs + 30s stacking timers on pickup
  (Use_* arithmetic, inventory-UI deviation documented); server tick
  applies protected air (+10s), alternating u_breath pair, enviro lava
  3->1x + slime immunity, airout fade warning; HUD-exposed seconds only.
- Yaw: C LerpAngle in @q2/client + driver prev-tick yaw with a
  render-cadence frac (6 renders/tick at 60fps), monotonic and bounded by
  the live yaw; position stays predictor-owned; no §6 contract change.
