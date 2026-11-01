---
'@q2/game': patch
'@q2/sw-renderer': patch
'@q2/webgl-renderer': patch
---

fix(game,sw-renderer,webgl-renderer): C button frame/effects texture states (RELEASE-16)

The secret's shootable button (*13, +0btshoot 4-frame chains) rendered its base frame forever: frame/effects were never modeled, submitted, or selected, so it looked always lit while its press motion was correct. Movers now carry C s.frame/s.effects (EF_ANIM01 at spawn, ANIM23 + frame 1 at TOP, frame 0 on return, ANIM01 restored at BOTTOM — buttons only) with a buttonAnimFrame() client rule (ANIM01 0-1 / ANIM23 2-3 at 2Hz, else s.frame). bspWorld bakes texinfo-next chains into MiniSurf.animTexIds; the driver picks the frame per tick (syncButtonAnim); software drops surface-cache entries on texId drift the same frame; WebGL2 re-syncs animated ranges per frame with no re-upload. No global illumination change; non-button faces untouched.

Tests: game 259/259; sw-renderer 189/189; web button-anim 4/4 (real base1: *13 shot swaps ANIM01->ANIM23 with +4z travel and secret preserved, repeat shots never re-fire, *34 E-use cycle walks ANIM01->ANIM23->ANIM23->ANIM01 with 2Hz rest flips, WebGL2 scene handles follow live texIds, forced-frame negative control fails the held assertion and moves only button pixels); webgl-renderer button-anim 3/3 (stub-GL rebind without re-upload, no-chain negative control, scene-side handles).
