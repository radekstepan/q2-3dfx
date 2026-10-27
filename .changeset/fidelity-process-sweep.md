---
"@q2/testkit": patch
"@q2/voodoo": patch
---

chore(testkit,voodoo,web): M4.1 capture harness, demo1 fallback note, still-open sweep

M4.1 human review (checkbox stays UNCHECKED — no real capture yet): new
side-by-side harness in `@q2/testkit` (`sidebyside.ts`: `compareSideBySide`
with the §10.3 ≤0.5% px / ≤1 LSB tolerance, `loadReferenceSlot` /
`writeActualSlot`, minimal `decodePng` for 8-bit RGB/RGBA reference PNGs,
`formatSideBySideReport`; missing reference reports `missing`, never
throws) plus written capture instructions (`CAPTURE-M4.1.md`: hardware /
wrapper setup, the 12 `vd_*` values, devroom + base1 cameras, sign-off
rule). `@q2/voodoo` adds `captureCVarTable()` (single source for the cvar
values). `devtools` adds a dependency-free human-review helper
(`summarizeReview`, `reviewReportHtml`, `captureChecklist`).

Demo1 fallback: the no-pak boot stays procedural/asset-free (`maps/devroom`
doubles as the demo1-era stand-in — `demo1.dm2` itself can't ship since it
needs the retail pak, §3); fixed fallback cameras added to `@q2/testkit`
(`demoFallbackViews`) and the web fallback boot path
(`demoFallbackCameras` in `apps/web/src/devroom.ts`), both covered by
asset-free tests. CI stays asset-free (Q2_PAK-gated tests still skip).

BRAIN sweep: deleted every §9 per-batch tail whose items are closed per
code/tests (M1.2 follow-up, M3.2/M3.3, M3.4 incl. per-monster meshes, M6.1,
M7.1, M8.1 duplicate done-when, M7.2 batches #2–#7); moved the genuinely
open leftovers (placeholder driver channel names, snapshot LerpAngle,
base1-flythrough cache hit-rate, lasfly folded into the M5.3 AI item) into
the §15 consolidated list, now the single source.
