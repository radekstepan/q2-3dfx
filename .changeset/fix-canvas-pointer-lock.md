"@q2/input": patch
---

Fix canvas-locked pointer/input: config-menu clicks no longer fire the weapon.

`attachToCanvas` listened for `mousedown` on `document`, so every click
anywhere — the cvar config panel, dropdowns, buttons — set `+attack` (and
`use`). Mouse fire/look are now gated on pointer-lock-on-canvas
(`document.pointerLockElement === canvas`): UI clicks and the lock-acquiring
canvas click never become game input and never disturb the lock state
machine. Lock loss (Esc) clears held fire/use via `pointerlockchange`, so
unlock can no longer stick `+attack` on. Mouseup stays document-global so a
release anywhere always clears. Keyboard flow is unchanged.
