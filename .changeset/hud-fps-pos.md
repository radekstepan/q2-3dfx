---
'web': patch
---

HUD lane: FPS readout moves to a DOM overlay top-right (`#q2-fps`, gated by `cl_showfps`) and the in-canvas fps text is deleted, so the counter never touches renderer output; player coordinates render as a DOM overlay top-left (`#q2-pos`, `pos x y z yaw <yaw>` at 1 decimal, updated per frame post-resolve, gated by the new `cl_showpos` default-ON cvar with a menu-panel checkbox). Checkbox wiring is element-local `change` only, so menu clicks never fire game input (canvas pointer-lock discipline holds).
