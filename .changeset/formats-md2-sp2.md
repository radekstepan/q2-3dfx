---
"@q2/formats": minor
---

feat(formats): real parseMD2 + verified parseSP2 (M1.2 follow-up)

Ports dmdl_t/dstvert_t/dtriangle_t/daliasframe_t from qcommon/qfiles.h.
parseMD2 returns flat typed arrays (no objects in the hot path): Float32Array
frames (v*scale+translate), Uint8Array normals, Int16Array st, Uint16Array
trisXyz/trisSt, plus scales/translates and skin/frame names; glcmds are
validated in-range but not stored. Magic (IDP2), version (8), qfiles.h upper
bounds, framesize, ordered offsets and tri indices are validated with
Com_Error('fatal', ...) on corrupt input.

parseSP2 verified correct against all 8 real pak0.pak sprites (ident IDS2,
version 2, dsprframe_t layout match the C header — no fix needed).

parseBSP38 stays a stub: the full loader lives in @q2/bsp loadBsp. The
frozen Bsp38 view is documented as structurally extended by BspMap (same
names/types for planes/nodes/leafs/faces/raw); re-pointing is a separate
contract-change PR per §12 rule 2.
