---
"@q2/client": patch
---

Fix residual stop jitter at the predictor tick boundary. `CL_Predict` rendered the staged prefix replay mid-interval, which overshoots the full 100ms friction step it prefixes (single-step friction decay is front-loaded, so a partial step travels farther than the whole tick) and snapped back ~0.5u when the tick landed. Inside the current tick the render now blends linearly from the snapshot to the server-exact tick end (one `SERVER_DT` pmove step with the latest staged cmd — exactly what the closing tick runs); past-the-tick catch-up keeps the whole-stream replay. Production stop: 4 backward snap-backs (max 0.54u) → 0, post-settle displacement 0.0.
