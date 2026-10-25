---
'@q2/server': patch
'@q2/game': patch
'@q2/sw-renderer': patch
'@q2/testkit': patch
---

WIRE: base1 end to end against the real shareware pak (asset-gated).

- server/game: world bridge (entities lump -> movers/triggers, 600+ edicts),
  BSP-backed pmove collision, scripted low-road bot to the exit complex,
  exit trigger-chain mechanism test (pit-floor overlap fires t37).
- sw-renderer: R_MarkLeaves ancestor marking (PVS-gates node faces) and
  output-identical backface culling (devroom golden preserved, 1.63x->1.33x).
- testkit: real-map opening-room renders (hashes logged, 1.81-2.36x overdraw).
- asset-cooker/web: real pak0.pak round-trip + client-side ingest tests.
