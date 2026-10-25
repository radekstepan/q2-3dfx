---
"web": minor
---

feat(web): brightness default 2.0, real pak MD2/skin registration, tracer beams (M7.2 follow-up)

- `r_brightness` default 1.25 → 2.0 (clamp 0.5..2.0, `brightness === 1` fast path unchanged; `CVAR_OPTIONS` already listed 2.0).
- `registerPakModels`: boot registers the real pak MD2s via `parseMD2` + `registerModel` and PCX skins via `parsePCX` + `registerSkinData` (`modelForMonster`/`skinForMonster`, `viewModelForWeapon`/`skinForWeaponModel`, bolt `modelForBolt`/`skinForBolt`). Soldier skin/mesh are handles 0, matching the Host's hardcoded `model: 0, skin: 0` snapshot entities. The first-person gun stays the 2D silhouette (per-weapon size/shape/caption, covered by a new selected-weapon-changes-pixels test) — a 3D view model needs a `@q2/host` entity-model contract change outside apps/web ownership.
- `pumpTracers` + driver tracer queue: every blaster bolt / shotgun pellet queues an eye→impact beam and every monster ranged shot queues a chest→eye beam, pumped into the renderer's `spawnTracer` pool (ttl 6 ≈ 0.1s) before the frame renders; wired into the dom rAF tick next to `pumpMuzzleLight`. Impact sparks stay on `mini.particles`.
