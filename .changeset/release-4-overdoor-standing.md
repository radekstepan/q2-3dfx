---
'@q2/server': patch
---

fix(server): over-door *34 housing plus genuine-standing lift finish (RELEASE-4)

The south-gap housing sat inside the south half of the open doorway at head height, so south-half entries blocked on it (the reported invisible wall; tests only walked center/north). The housing now hovers centered above the doorway (+145 X, +0 Y, +40 Z: -1703..-1694, 1520..1552, 160..192) — 1u off the shut face, west of the slider plane, 8u above every hull, E-use-only. Entry at any offset passes under it; first E-use opens the plug (t4, no finish), boarding drops onto the open top, second E-use from aboard finishes 'lift' with frozen F1.

Also closes a premature-finish hole the relocation exposed: leaning on the plug face parks the body at contact rest overlapping the clip, so the pmove ground trace latches the plug num with deck feet and the old ground-only guard finished on the first face press. SV_StandingOn requires the latched ground link PLUS feet on the clip's live box top (4u) PLUS the hull-margin footprint, latched via SV_SetPlayerGround(st, ge, feet). Face leans open the plug without finishing; boarding still finishes exactly once.

Tests: server base1 33/33 (multi-offset approach, face-lean no-finish, boarding finish, traversal E-use endgame); web release-4-trace 6/6 (Y 1492/1536/1568: visual==collision, face stop owns plug, E-use opens, board ge==plug no finish, aboard E-use finishes once, F1 frozen), elevator 1/1, ride-gate 1/1, base1-gate 24/24.
