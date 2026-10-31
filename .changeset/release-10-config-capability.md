---
'@q2/config': patch
---

Add RELEASE-10 renderer capability mapping: RENDERER_CVAR_SUPPORT plus isCVarSupportedBy/supportReason/resolveEffectiveRenderer (failed-GPU fallback counts as software; unknown cvars default to shared so new cvars never brick the panel). Corrects draft audit claims against grepped consumers: sw_gamma/r_drawworld/vd_palettetex/cl_interp decorative on both renderers; r_translucency/sw_stipplealpha/r_brightness software-only; vd_dithermode/vd_reconmode/vd_zbits/vd_rgbmaxdelta live on WebGL.
