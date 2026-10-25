# @q2/math

Vec3/mat4/angles/plane/frustum helpers plus 16.16 fixed point, in Quake II
conventions (+X forward, +Y left, +Z up; angles `[pitch, yaw, roll]` in
degrees, pitch positive = down). Ports `game/q_shared.c` (`AngleVectors`,
`BoxOnPlaneSide`, `LerpAngle`, `anglemod`, `ProjectPointOnPlane`,
`PerpendicularVector`, `RotatePointAroundVector`), the `qcommon/qfiles.h`
plane types, and the view/frustum half of `ref_soft/r_misc.c`.

## Public API

Entry point: `src/index.ts`. All vectors are `Float32Array(3)` (`Vec3`,
`src/index.ts:40`); all matrices are column-major `Float32Array(16)`
(`Mat4`, `src/index.ts:278`).

- `v3 / v3set / v3copy / v3copyTo / v3add / v3sub / v3scale / v3ma / v3negate / v3clear` — allocation-free vector ops (`src/index.ts:42`).
- `dot / cross / normalize / v3length / v3lengthSq / v3dist / v3equals` — scalar helpers (`src/index.ts:106`).
- `AngleVectors(angles, fwd?, right?, up?)` — id's basis vectors (`src/index.ts:158`).
- `anglemod / lerpAngle / dirToAngles` — angle wrap, shortest-arc lerp (note arg order `(a2, a1, frac)`), direction-to-angles (`src/index.ts:171`).
- `PlanePoint / perpendicularVector / rotatePointAroundVector` — plane projection and rotation ports (`src/index.ts:203`).
- `m4identity / m4multiply / m4perspective / m4view` — column-major matrices; `m4view` yields Q2 *view* space (x=right, y=up, z=forward), not OpenGL eye space (`src/index.ts:281`).
- `m4transformPoint / m4transformDir` — point (with divide) vs direction transform (`src/index.ts:355`).
- `Plane / makePlane / PlaneDiff / planeTypeForNormal / planeSignbits` — classified `cplane_t` with axial fast path (`src/index.ts:381`).
- `BoxOnPlaneSide / boxOnPlane / boxInFrustum` — slow general vs fast classified side tests, frustum cull (`src/index.ts:441`).
- `FrustumFromView(origin, angles, fovXDeg, fovYDeg)` — 4 inward-facing planes, ports `R_ViewChanged` + `R_TransformFrustum` (`src/index.ts:504`).
- `FIX_SHIFT / FIX_ONE / FIX_HALF / FIX_MASK / floatToFix / fixToFloat / fixMul / fixDiv / fixClamp` — 16.16 fixed point from `d_scan.c` (`src/index.ts:550`).

## Usage

Consumed by `@q2/formats` (types only), `@q2/bsp` (`BoxOnPlaneSide` in
`trace.ts`), `@q2/renderer-api`, `@q2/game`, `@q2/sw-renderer`,
`@q2/voodoo`, `@q2/server`, `@q2/testkit`. Mirrors `@q2/config`'s `LUXEL`.

```ts
import { v3, AngleVectors, m4view, FrustumFromView } from '@q2/math';
const origin = v3(96, -224, 24), angles = v3(0, 90, 0);
const fwd = v3(), right = v3(), up = v3();
AngleVectors(angles, fwd, right, up);
const view = m4view(origin, angles);
const frustum = FrustumFromView(origin, angles, 90, 75);
```

## Testing

```bash
yarn workspace @q2/math test
```

`src/math.test.ts` covers vec3/mat4/planes/fixed point; `src/angleVectors.test.ts`
checks `AngleVectors` against C-captured values. No fixtures or goldens.

## Constraints

Dependency direction (BRAIN.md §4): `@q2/math` may depend only on `@q2/config`
(it does: `package.json`). Nothing below it; never import `formats`,
`filesystem`, `bsp`, or anything upstream. Pure TS, no DOM, no Node APIs —
runs in browser, worker, and Node headless tests.
