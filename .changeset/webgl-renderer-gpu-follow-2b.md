---
"@q2/webgl-renderer": patch
---

GPU-FOLLOW-2B texture/lightmap correctness: world WAL diffuse uses REPEAT (negative/multi-tile UVs) vs CLAMP for skins/sprites/atlas, explicit UNPACK_ALIGNMENT 1 + restore with GL-error warnings, per-draw unit-0 diffuse + unit-1 lightmap re-bind with uDebugMode upload (diffuse-only / lightmap-only / final triage), atlas stats/material-count hooks wired, packLightAtlas resolves surf.lightId % len (CPU parity), per-luxel short-fill + reserved unlit tile with 1-texel gutters and luxel-centre UVs.
