---
"@q2/input": patch
---

`attachToCanvas(canvas, target?)` uses a caller-supplied `InputCore` when given (lets the web shell share `Host.input`); jump now also produces `upmove +400`, which is what `pmove`'s `PM_CheckJump` requires (previously Space only set a button bit the physics never read). New `./dom` export entry.
