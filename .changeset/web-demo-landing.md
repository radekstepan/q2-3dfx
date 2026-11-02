---
'web': patch
---

Landing-first boot with in-browser shareware demo download (qwasm2-style)

- New `src/demo.ts`: fetches `q2-314-demo-x86.exe` (same-origin `/demo/`
  first, then Yamagi/tastyspleen mirrors), verifies SHA-256, extracts
  `Install/Data/baseq2/pak0.pak` from the self-extract ZIP via
  `DecompressionStream`, checks `PACK` magic + pak hash. All client-side;
  nothing hosted or committed.
- New landing overlay (`index.html#q2-landing`, `src/landing.ts`):
  play shareware demo / continue cached pak / drop-pick pak0.pak / devroom,
  with status line, license note, and a file picker. Cached pak enables
  continue but never auto-boots (the click is the audio-unlock gesture).
- `src/index.ts`: landing wiring (demo → ingest → IndexedDB cache → boot),
  footer `menu` button to reopen the landing, clear-cache returns to landing.
- `public/demo/README.md`: operator note for mirroring the unmodified demo
  exe next to the page (CORS-free fetch); exe/pak stay git-ignored.
