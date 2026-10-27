---
"@q2/config": patch
---

fix(config): honest vd_* semantics + read-only profile-data cvars (V2e)

- Rewrote all 12 `vd_*` description strings to match post-M1 true semantics: `vd_16bit` bypass (gamma-on/dither-off), `vd_bilinear` independent of `vd_palettetex` (storage policy), `vd_lodbias` added-to-log2rho (negative = finer), `vd_zbits` precision-at-test (frame helper is banding-only), `vd_overbright` explicit compat policy pending `gl_image` audit, `vd_fog` capability gate with zero-contribution default, `vd_gamma` display-stage transfer, `vd_postfilter` matched reconstruction incl. stale-guard, `vd_mipdither`/`vd_maxtexsize` real-resample note. No default values changed (legacy preset stays).
- Added read-path-only profile-data cvars defaulting to current behavior: `vd_dithermode` (`4x4`), `vd_reconmode` (`legacy`; hw modes `2x2sub+2x2box`/`4x4sub+4x1` reserved), `vd_rgbmaxdelta` (`0,0,0` = no rejection). No behavior change anywhere.
- `docs/renderers.md` §7.2 table updated to match; legacy preset + HW-capture requirement noted.
