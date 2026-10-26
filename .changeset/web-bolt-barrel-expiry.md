---
"web": patch
---

fix(web): bolt 2s life, particle expiry, barrel/explosion entities

- Blaster bolts now expire on server time (`server.time - born >= life`,
  id's `G_FreeEdict at level.time + 2`) instead of `life -= dt`, so the 2s
  fuse is exact regardless of the step quantum. Movement still integrates
  the tick quantum. Headless test: fire skyward (no ceiling in the analytic
  room), step 3s of ticks, bolts are gone.
- Trail/impact sparks now age out (`SPARK_TTL = 0.4s`, swept every server
  tick) instead of lingering in the 256-entry cap-only ring — the bolt path
  no longer stays visible as a permanent spark line. World-seeded particles
  (devroom torch flame, born +Infinity) are preserved; the sentinel is
  +Infinity because `time - (-Infinity)` is +Infinity and would expire
  instantly. The same test asserts the static count is intact after 3s.
- Impact flash window `drainExplosions()` 0.3s → `EXPLOSION_LIGHT_WINDOW`
  (0.1s, authentic brief TE_BLASTER); `server.time` advances in seconds via
  `SV_Tick`, verified. The `drainFlash` one-shot gate already drops stale
  requests and is now pinned by test. Test: impact → pump adds the light →
  after 0.5s the drain is empty and the renderer holds no lights.
- Start-room barrels: dumped the base1 entities lump — 9 misc_explobox +
  2 func_explosive (11 total); the (136,40,0)/(184,-24,0) pair rests exactly
  on the floor (drop probe moves 0.03), so lump origins are kept with no
  hull drop (id M_droptofloor outcome). Barrel hitbox is now the authentic
  (-16,-16,0)-(16,16,40). No trigger_always targets a target_explosion
  (t148/t142/t134 fire strogg-ship flybys, t91 a secret/train/button), so
  boot fires no premature blast (the tick-0 t70→t151 showcase is server-side
  map scripting via trigger_once *16, visible by design).
- Barrels/bolts are exposed to Host rendering through the landed `@q2/host`
  pairing: snapshot stays player + monsters, live barrels + flying bolts go
  through `extraEntities()` with explicit MD2 model/skin/angles, and
  `entityModel()` returns per-kind soldier/gunner handles (`entityAngles()`
  stays legacy null). Barrel MD2/skin (`models/objects/barrels/*`) register
  after the bolt so all existing handles are stable. Q2_PAK test asserts 11
  barrels, the exact start-room pair, non-null extras with barrel handles,
  a fired bolt extra with flight yaw, and both present in `renderView`.
- dom.ts rAF ordering (muzzle → explosions → tracers → frame) unchanged.
