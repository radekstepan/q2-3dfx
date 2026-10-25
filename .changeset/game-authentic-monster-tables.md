---
"@q2/game": patch
---

fix(game): authentic soldier/gunner move tables, hull origin, per-frame dists

Port the real MD2 frame numbers (m_soldier.h/m_gunner.h FRAME_* constants)
instead of name-suffix numbers, with the per-frame ai_move/ai_run/ai_walk
distances from m_soldier.c/m_gunner.c. Restore the id hull
(mins -16,-16,-24 / maxs +16,+16,+32): the origin sits 24 units above the
feet, so feet-space (0..56) sank models halfway into the floor. Web driver
drops lump origins to the floor (M_droptofloor) and steers via
monsterChaseMove each tick, so idle stand flips to run/attack and
locomotion has a nonzero dist to play — monsters walk instead of sliding
in place on the wrong frames.
