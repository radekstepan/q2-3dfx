---
'@q2/client': minor
---

Add `loadConcharsFont` (TODO(M6.1)): convert the real 128x128 `pics/conchars.pcx` into a `ConcharsFont` (256*64 bytes of 0/1, row-major 16x16 grid of 8x8 cells, per ref_soft `Draw_Char`). Accepts a decoded image object (`{ width, height, pixels }`, structurally assignable from `parsePCX` output) or raw pre-decoded pixels; palette index 255 (id `TRANSPARENT_COLOR`) maps to 0, all other indices to 1. `makeConcharsFont` stays as the `getConcharsFont` fallback. Exported from `@q2/client` with `ConcharsImage`, `CONCHARS_PIC_SIZE`, `CONCHARS_GRID`, and `CONCHARS_TRANSPARENT`.
