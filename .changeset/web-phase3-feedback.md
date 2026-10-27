---
'web': patch
---

fix(web): muzzle/dlight/duck feedback correctness (Phase 3)

- Enemy muzzle flash is view-contract pinned: every foe hitscan streak is a
  48u muzzle-origin streak (pairs 1:1 with a same-tick enemy muzzle flash at
  the m_flash point), never a chest→eye beam; endpoints stay 2m clear of the
  player eye at sane ranges; pumped renderer beams (spawnTracer) obey the
  same cap. Player hitscan (shotgun pellets) queues no beam at all.
- Player muzzle audit pinned: pos feet+fwd*18+right*16, radius 200+(rand&31),
  pure yellow, single-frame expiry with no accumulation across the pump path,
  and clean re-arm on the next shot.
- Single duck state: the driver only asserts PMF_DUCKED while the hold bit is
  down and never clears it — release flows through PM_CheckDuck's
  headroom-checked stand-up (letting go under a ceiling keeps the hull
  ducked). The host eye and the mixer listener both ride the authoritative
  pm.viewheight instead of the raw cmd bit / hardcoded +22, so hold-60-ticks
  keeps hull maxs 4 / viewheight 12 / eye +12 every tick with one transition
  per edge.
- Point-blank accumulation bots (devroom pillar + Q2_PAK base1 spawn wall):
  100+ shots into the wall keep the live renderer dlight count ≤ 4 every
  frame and return to zero with quiet pumps after release.
