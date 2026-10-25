---
'@q2/client': minor
---

Hook up client prediction to the real headless pmove step (TODO(M6.1)). `CL_Predict` replays the owned usercmd stream through `pmoveFull` from `@q2/game` (same `PM_StepSlideMove` code path as the server, dt from `cmd.msec` only) when cmds are supplied and `cl_predict` is nonzero; otherwise it keeps the legacy constant-velocity extrapolation as an A/B baseline. `Predictor` gains `setPendingCmds`/`clearPendingCmds`. Interpolation path untouched.
