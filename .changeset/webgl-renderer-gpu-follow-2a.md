---
"@q2/webgl-renderer": patch
---

FOLLOW-2A renderer-side hot-swap repair: idempotent same-handle registerModelData/registerSkinPixels replay (overwrite + GL cache drop, kind preserved) with explicit handle/kind/dims warnings on missing or invalid asset data instead of silent mesh-less skips; drawAlias records handle/kind-context warnings for missing meshes; new registry/cache test hooks for web/testkit replay observability.
