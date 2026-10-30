---
"@q2/testkit": patch
---

GPU-FOLLOW-2C (testkit lane): semantic scene content + occlusion coverage. Adds the live-route observation shape (`LiveRouteSemanticCapture`), a hermetic two-room fixture with named wall/floor/ceiling regions plus an opaque occluder, a CPU-reference oracle (`deriveSemanticOracle`: visibility from CPU traversal, pixel floors from `SoftwareRenderer` renders), and the successor gate `validateSceneCoverageAndContent`, with tests rejecting removed wall/enemy/viewmodel and occluder leaks at healthy submission counts.
