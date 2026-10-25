// @q2/sw-renderer devroom — maps/devroom procedural fallback (BRAIN.md §8).
// A closed room with a pillar, checker textures, one dynamic light, one
// alias mesh, one sprite and a static spark burst. Keeps CI + golden tests
// asset-free. Built once and reused.

import { createBoxMesh, type AliasMesh } from './alias.js';
import type { MiniSurf, MiniWorld } from './worldNodes.js';

export const DEVROOM_CAMERA = {
  origin: new Float32Array([-168, 0, 136]),
  angles: new Float32Array([0, 0, 0]),
  fovX: 90,
};

function checker(size: number, a: number, b: number, cell: number): Uint8Array {
  const t = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = (((x / cell) | 0) + ((y / cell) | 0)) & 1;
      t[y * size + x] = c === 0 ? a : b;
    }
  }
  return t;
}

function radial(size: number, inner: number, outer: number): Uint8Array {
  const t = new Uint8Array(size * size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.sqrt((x - c) * (x - c) + (y - c) * (y - c)) / c;
      t[y * size + x] = d < 0.35 ? inner : d < 0.8 ? outer : 0;
    }
  }
  return t;
}

function bboxOf(verts: Float32Array): { mins: Float32Array; maxs: Float32Array; center: Float32Array; radius: number } {
  const mins = new Float32Array([Infinity, Infinity, Infinity]);
  const maxs = new Float32Array([-Infinity, -Infinity, -Infinity]);
  const n = verts.length / 3;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = verts[i * 3 + k]!;
      if (v < mins[k]!) mins[k] = v;
      if (v > maxs[k]!) maxs[k] = v;
    }
  }
  const center = new Float32Array([
    (mins[0]! + maxs[0]!) / 2,
    (mins[1]! + maxs[1]!) / 2,
    (mins[2]! + maxs[2]!) / 2,
  ]);
  let r2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = verts[i * 3]! - center[0]!;
    const dy = verts[i * 3 + 1]! - center[1]!;
    const dz = verts[i * 3 + 2]! - center[2]!;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) r2 = d2;
  }
  return { mins, maxs, center, radius: Math.sqrt(r2) };
}

let surfId = 0;

function quad(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
  texId: number, lightId: number, turbulent: boolean,
  luxBase: number,
): MiniSurf {
  const verts = new Float32Array([ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz]);
  // full-texture mapping across the quad (64x64 texel space)
  const uvs = new Float32Array([0, 0, 64, 0, 64, 64, 0, 64]);
  // full luxel grid mapping (luxW x luxH of the surface lightmap)
  const lux = new Float32Array([0, 0, 4, 0, 4, 4, 0, 4]);
  void luxBase;
  const bb = bboxOf(verts);
  return {
    id: surfId++, verts, uvs, lux, n: 4, texId, lightId,
    center: bb.center, radius: bb.radius, mins: bb.mins, maxs: bb.maxs,
    turbulent,
  };
}

function flatLight(luxW: number, luxH: number, base: number, hotX: number, hotY: number, hot: number): Uint8Array {
  // RGB luxels: dim base with one hot spot (deterministic gradient)
  const s = new Uint8Array(luxW * luxH * 3);
  for (let y = 0; y < luxH; y++) {
    for (let x = 0; x < luxW; x++) {
      const dx = x - hotX, dy = y - hotY;
      const d2 = dx * dx + dy * dy;
      const v = Math.min(255, Math.round(base + hot / (1 + d2)));
      const i = (y * luxW + x) * 3;
      s[i] = v; s[i + 1] = Math.round(v * 0.9); s[i + 2] = Math.round(v * 0.75);
    }
  }
  return s;
}

const MESHES: AliasMesh[] = [];

export function getDevMesh(id: number): AliasMesh {
  const m = MESHES[id % MESHES.length];
  if (!m) throw new Error(`no dev mesh ${id}`);
  return m;
}

let cached: MiniWorld | null = null;

export function createDevroom(): MiniWorld {
  if (cached) return cached;
  surfId = 0;
  MESHES.length = 0;
  MESHES.push(createBoxMesh(20));
  const H = 256; // room height
  const R = 256; // half-extent
  const P = 48;  // pillar half-extent
  const PH = 192; // pillar height
  const surfaces: MiniSurf[] = [
    // floor z=0 (normal +z), viewed from above
    quad(-R, -R, 0, -R, R, 0, R, R, 0, R, -R, 0, 0, 0, false, 0),
    // ceiling z=H
    quad(-R, R, H, -R, -R, H, R, -R, H, R, R, H, 1, 1, false, 0),
    // wall x=+R (normal -x)
    quad(R, -R, 0, R, R, 0, R, R, H, R, -R, H, 1, 1, false, 0),
    // wall x=-R (normal +x)
    quad(-R, R, 0, -R, -R, 0, -R, -R, H, -R, R, H, 0, 0, false, 0),
    // wall y=+R, turbulent water banner
    quad(-R, R, 0, R, R, 0, R, R, H, -R, R, H, 1, 2, true, 0),
    // wall y=-R
    quad(R, -R, 0, -R, -R, 0, -R, -R, H, R, -R, H, 0, 0, false, 0),
    // pillar sides + top
    quad(-P, -P, 0, -P, P, 0, -P, P, PH, -P, -P, PH, 0, 3, false, 0),
    quad(P, P, 0, P, -P, 0, P, -P, PH, P, P, PH, 0, 3, false, 0),
    quad(-P, P, 0, P, P, 0, P, P, PH, -P, P, PH, 1, 3, false, 0),
    quad(P, -P, 0, -P, -P, 0, -P, -P, PH, P, -P, PH, 1, 3, false, 0),
    quad(-P, -P, PH, P, -P, PH, P, P, PH, -P, P, PH, 0, 3, false, 0),
  ];
  const world: MiniWorld = {
    brand: 'miniworld',
    nodes: [],
    leafs: [{ cluster: 0, firstSurf: 0, numSurfs: surfaces.length }],
    pvs: [new Uint8Array([1])],
    clusterCount: 1,
    surfaces,
    textures: [
      { texels: checker(64, 200, 90, 8), width: 64, height: 64 },
      { texels: checker(64, 160, 60, 16), width: 64, height: 64 },
      { texels: radial(32, 220, 120), width: 32, height: 32 },
    ],
    lightmaps: [
      { samples: flatLight(4, 4, 150, 1, 1, 160), luxW: 4, luxH: 4, styles: [0] },
      { samples: flatLight(4, 4, 110, 2, 2, 120), luxW: 4, luxH: 4, styles: [0] },
      { samples: flatLight(4, 4, 170, 2, 1, 200), luxW: 4, luxH: 4, styles: [1] },
      { samples: flatLight(4, 4, 190, 1, 2, 220), luxW: 4, luxH: 4, styles: [0] },
    ],
    // No active dynamic lights by default: static lighting is baked into the
    // luxels above. Tests drive the dynamic path via testAddDynamicLight.
    dynamicLights: [],
    alias: [
      {
        meshId: 0,
        origin: new Float32Array([60, -90, 20]),
        angles: new Float32Array([0, 35, 0]),
        frameA: 0, frameB: 1, lerp: 0.4,
        skinId: 2,
      },
    ],
    sprites: [
      { origin: new Float32Array([60, 40, 150]), size: 36, skinId: 2 },
    ],
    particles: [
      { origin: new Float32Array([60, 40, 130]), color: 250 },
      { origin: new Float32Array([66, 44, 136]), color: 248 },
      { origin: new Float32Array([54, 36, 142]), color: 246 },
      { origin: new Float32Array([63, 47, 124]), color: 244 },
      { origin: new Float32Array([57, 33, 133]), color: 242 },
      { origin: new Float32Array([70, 38, 145]), color: 240 },
      { origin: new Float32Array([50, 45, 127]), color: 238 },
      { origin: new Float32Array([64, 30, 139]), color: 236 },
    ],
  };
  cached = world;
  return world;
}

/** Procedural skin registry for alias/sprite tests (indexed by skinId). */
export function createDevSkins(): { texels: Uint8Array; width: number; height: number }[] {
  const w = createDevroom();
  return w.textures.map((t) => ({ texels: t.texels, width: t.width, height: t.height }));
}
