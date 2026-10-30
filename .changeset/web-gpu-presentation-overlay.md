---
'web': patch
---

GPU-FOLLOW-0: fix the black browser presentation. The `#q2` HUD canvas stylesheet `background:#000` painted opaque black over the `#q2-gl` WebGL canvas (HUD at z-index 1 above GL at 0); transparent overlay ImageData cannot remove a CSS background. GPU attach now toggles the HUD inline background to `transparent` (restored to stylesheet black on CPU fallback/switch), syncs the GL canvas CSS geometry to the HUD displayed size on acquire/loop-start/every GPU tick (absolute left/top 0, matching width/height, mirrored max-width/max-height capping so bezel-capped viewports shrink both boxes identically), and removes/hides `#q2-gl` with HUD stacking restore on CPU fallback. Adds `#q2-gl` CSS so pre-JS paint aligns, plus stub-DOM regression pins.
