---
'@q2/config': major
---

RELEASE-8: remove `voodoo` from the `vid_renderer` vocabulary (`software | webgl2-experimental`) and remove the `features.voodoo` flag. Persisted `voodoo` ids migrate one-time to `software` with an explicit warning (never silent, never auto-promoted to webgl2). `vd_*` cvars unchanged (WebGL live-uniforms).
