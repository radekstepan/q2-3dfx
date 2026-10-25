---
'@q2/client': minor
---

Replace the `makeConcharsFont` fallback (TODO(M6.1)) with a readable baked 8x8 font: hand-authored 1px-stroke bit patterns for A-Z, 0-9 and basic punctuation, blank space/NUL/DEL, lowercase mirroring uppercase, high-half (128-255) mirroring the low half. No border frames, no hash noise, so devroom HUD text (`fps`, HP, weapon) is legible at 1x without a pak. Same `ConcharsFont` layout (256x64 bytes of 0/1), same exports, same `getConcharsFont` fallback semantics; `loadConcharsFont` (real `pics/conchars.pcx`) stays the preferred path via `setConcharsFont`.
