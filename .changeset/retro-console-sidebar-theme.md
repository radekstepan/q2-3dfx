---
'web': patch
---

Port the retro console + sidebar faceplate theme into the playable web shell

- `apps/web/index.html`: replaces the military-stencil sidebar with the `retro-game-settings-ui` theme (void/surface/panel palette, amber `#ff7a18` accents, silk micro-labels, milled faceplate header, thin scrollbars, CRT glass edge) laid out as the reference top strip + viewport/console split + 418px faceplate sidebar; keeps the live `#q2` canvas, `#q2-cvars` panel, `#q2-progress`, and pak drop-zone hooks intact.
- `apps/web/src/dom.ts`: adds the headless-safe console strip store (`pushConsoleLog` / `clearConsoleLog` / `renderConsoleLines` / `attachConsoleClear`, 40-line cap, `cmd/info/warn/ok` kinds) plus `setModeReadout` for the top-strip/faceplate mode box, and tags sidebar groups with `data-index` section numbers (`01`–`07`).
- `apps/web/src/index.ts`: wires boot/cvar/reboot/drop events to the console strip, mirrors the framebuffer size + map source into the mode readouts, and binds the static faceplate footer (`revert view`, `clear cached pak`) instead of injecting buttons.
