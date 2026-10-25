// @q2/sw-renderer bspWorld — WIRE bridge: real BSP38 maps as a MiniWorld.
//
// Converts a full BspMap (19 lumps, from @q2/bsp loadBsp) into the flat
// MiniWorld the software renderer traverses: faces become index-stable
// surfaces (face i <-> surface i, so node firstface/numfaces ranges stay
// valid), leafs keep explicit face lists from the leaffaces lump, nodes map
// 1:1, and PVS rows are decompressed per cluster. Textures come from a
// caller-supplied WAL lookup so this module stays filesystem-free; lightmaps
// are per-face RGB blocks cut out of the lighting lump.
//
// Faces carrying SURF_NODRAW are kept as degenerate (n = 0) surfaces so all
// indices stay stable; the renderer skips them before cache lookup.
import { clusterPVS, FACE_STRIDE } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import type { MiniLeaf, MiniLightmap, MiniNode, MiniSurf, MiniTexture, MiniWorld } from './worldNodes.js';

/** Q2 surface flags (qfiles.h texinfo_t): only warp + nodraw matter here. */
export const SURF_SKY = 0x4;
export const SURF_WARP = 0x8;
export const SURF_NODRAW = 0x80;

/** Mip-0 texel source for a WAL texture, or null for the checker fallback. */
export interface BspTexelSource {
  texels: Uint8Array;
  width: number;
  height: number;
}

export interface BspWorldOptions {
  /** WAL lookup by texinfo name (e.g. `e1u1/metal2_1`); null = fallback. */
  texelFor?: (walName: string) => BspTexelSource | null;
}

function isPow2(v: number): boolean {
  return v > 0 && (v & (v - 1)) === 0;
}

function checker(size: number, a: number, b: number): Uint8Array {
  const t = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      t[y * size + x] = ((x >> 3) + (y >> 3)) & 1 ? a : b;
    }
  }
  return t;
}

const FALLBACK: MiniTexture = { texels: checker(64, 200, 90), width: 64, height: 64 };

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
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }
  return { mins, maxs, center, radius: Math.sqrt(r2) };
}

/**
 * Convert a loaded BSP map to a renderable MiniWorld.
 * Pure (no allocation policy beyond the build); deterministic.
 */
export function bspToMiniWorld(map: BspMap, opts: BspWorldOptions = {}): MiniWorld {
  const nFaces = map.faces.length / FACE_STRIDE;
  const texIndex = new Map<string, number>();
  const textures: MiniTexture[] = [];
  const lightmaps: MiniLightmap[] = new Array(nFaces);
  const surfaces: MiniSurf[] = new Array(nFaces);

  const texelFor = opts.texelFor;
  const texIdFor = (walName: string): number => {
    const hit = texIndex.get(walName);
    if (hit !== undefined) return hit;
    let tex: MiniTexture = FALLBACK;
    const src = texelFor ? texelFor(walName) : null;
    if (src && isPow2(src.width) && isPow2(src.height) && src.texels.length >= src.width * src.height) {
      tex = { texels: src.texels.slice(0, src.width * src.height), width: src.width, height: src.height };
    }
    const id = textures.length;
    textures.push(tex);
    texIndex.set(walName, id);
    return id;
  };

  const LUXEL = 16;
  for (let f = 0; f < nFaces; f++) {
    const d = f * FACE_STRIDE;
    const firstedge = map.faces[d + 2]!;
    const numedges = map.faces[d + 3]!;
    const ti = map.faces[d + 4]!;
    const flags = map.texinfoFlags[ti] ?? 0;
    if (numedges < 3 || numedges > 64 || (flags & SURF_NODRAW) !== 0) {
      const empty = new Float32Array(0);
      surfaces[f] = {
        id: f, verts: empty, uvs: new Float32Array(0), lux: new Float32Array(0), n: 0,
        texId: 0, lightId: f, center: new Float32Array(3), radius: 0,
        mins: new Float32Array(3), maxs: new Float32Array(3), turbulent: false,
        sky: false,
        fn: new Float32Array([0, 0, 1]),
      };
      lightmaps[f] = { samples: new Uint8Array([128, 128, 128]), luxW: 1, luxH: 1, styles: [0, 0, 0, 0] };
      continue;
    }
    const verts = new Float32Array(numedges * 3);
    for (let k = 0; k < numedges; k++) {
      const se = map.surfedges[firstedge + k]!;
      const e = se < 0 ? -se : se;
      const v0 = map.edges[e * 2]!;
      const v1 = map.edges[e * 2 + 1]!;
      const vi = se >= 0 ? v0 : v1;
      verts[k * 3] = map.vertexes[vi * 3]!;
      verts[k * 3 + 1] = map.vertexes[vi * 3 + 1]!;
      verts[k * 3 + 2] = map.vertexes[vi * 3 + 2]!;
    }
    // texture-space coords (texels of mip 0): u = dot(p, s) + s_off
    const sv = map.texinfoVecs;
    const s0 = sv[ti * 8]!, s1 = sv[ti * 8 + 1]!, s2 = sv[ti * 8 + 2]!, so = sv[ti * 8 + 3]!;
    const t0 = sv[ti * 8 + 4]!, t1 = sv[ti * 8 + 5]!, t2 = sv[ti * 8 + 6]!, to = sv[ti * 8 + 7]!;
    const uvs = new Float32Array(numedges * 2);
    let minS = Infinity, maxS = -Infinity, minT = Infinity, maxT = -Infinity;
    for (let k = 0; k < numedges; k++) {
      const x = verts[k * 3]!, y = verts[k * 3 + 1]!, z = verts[k * 3 + 2]!;
      const u = x * s0 + y * s1 + z * s2 + so;
      const v = x * t0 + y * t1 + z * t2 + to;
      uvs[k * 2] = u;
      uvs[k * 2 + 1] = v;
      if (u < minS) minS = u;
      if (u > maxS) maxS = u;
      if (v < minT) minT = v;
      if (v > maxT) maxT = v;
    }
    // luxel grid (r_surf.c extents): floor to 16, +1 luxel per side
    const luxW = Math.min(256, Math.max(1, Math.floor((maxS - minS) / LUXEL) + 1));
    const luxH = Math.min(256, Math.max(1, Math.floor((maxT - minT) / LUXEL) + 1));
    const baseS = Math.floor(minS / LUXEL) * LUXEL;
    const baseT = Math.floor(minT / LUXEL) * LUXEL;
    const lux = new Float32Array(numedges * 2);
    for (let k = 0; k < numedges; k++) {
      lux[k * 2] = (uvs[k * 2]! - baseS) / LUXEL;
      lux[k * 2 + 1] = (uvs[k * 2 + 1]! - baseT) / LUXEL;
    }
    const lightofs = map.faces[d + 9]!;
    let samples: Uint8Array;
    const need = luxW * luxH * 3;
    if (lightofs >= 0 && lightofs + need <= map.lighting.length) {
      samples = map.lighting.slice(lightofs, lightofs + need);
    } else {
      samples = new Uint8Array([128, 128, 128]);
    }
    lightmaps[f] = {
      samples,
      luxW,
      luxH,
      styles: [map.faces[d + 5]!, map.faces[d + 6]!, map.faces[d + 7]!, map.faces[d + 8]!],
    };
    const bb = bboxOf(verts);
    // front normal from the face plane (planeback flips the visible side)
    const pn = map.faces[d]!;
    const side = map.faces[d + 1]!;
    const sgn = side !== 0 ? -1 : 1;
    surfaces[f] = {
      id: f,
      verts,
      uvs,
      lux,
      n: numedges,
      texId: texIdFor(map.texinfoNames[ti] ?? ''),
      lightId: f,
      center: bb.center,
      radius: bb.radius,
      mins: bb.mins,
      maxs: bb.maxs,
      turbulent: (flags & SURF_WARP) !== 0,
      sky: (flags & SURF_SKY) !== 0,
      fn: new Float32Array([
        map.planes[pn * 4]! * sgn,
        map.planes[pn * 4 + 1]! * sgn,
        map.planes[pn * 4 + 2]! * sgn,
      ]),
    };
  }
  if (textures.length === 0) textures.push(FALLBACK);

  // nodes map 1:1 (front = children[0], back = children[1], same as trace)
  const nNodes = map.nodes.length / 11;
  const nodes: MiniNode[] = new Array(nNodes);
  for (let i = 0; i < nNodes; i++) {
    const b = i * 11;
    const plane = map.nodes[b]!;
    nodes[i] = {
      nx: map.planes[plane * 4]!,
      ny: map.planes[plane * 4 + 1]!,
      nz: map.planes[plane * 4 + 2]!,
      dist: map.planes[plane * 4 + 3]!,
      front: map.nodes[b + 1]!,
      back: map.nodes[b + 2]!,
      mins: new Float32Array([map.nodeMins[i * 3]!, map.nodeMins[i * 3 + 1]!, map.nodeMins[i * 3 + 2]!]),
      maxs: new Float32Array([map.nodeMaxs[i * 3]!, map.nodeMaxs[i * 3 + 1]!, map.nodeMaxs[i * 3 + 2]!]),
      firstSurf: map.nodes[b + 9]!,
      numSurfs: map.nodes[b + 10]!,
    };
  }

  // leafs keep explicit face lists (leaffaces are non-contiguous)
  const nLeafs = map.leafs.length / 13;
  const leafs: MiniLeaf[] = new Array(nLeafs);
  for (let i = 0; i < nLeafs; i++) {
    const b = i * 13;
    const first = map.leafs[b + 9]!;
    const count = map.leafs[b + 10]!;
    const list: number[] = new Array(count);
    for (let k = 0; k < count; k++) list[k] = map.leaffaces[first + k]!;
    leafs[i] = {
      cluster: map.leafs[b + 1]!,
      firstSurf: 0,
      numSurfs: 0,
      faceList: list,
    };
  }

  // decompressed PVS rows, one per cluster
  const pvs: Uint8Array[] = new Array(map.numClusters);
  for (let c = 0; c < map.numClusters; c++) pvs[c] = clusterPVS(map, c);

  return {
    brand: 'miniworld',
    nodes,
    leafs,
    pvs,
    clusterCount: map.numClusters,
    surfaces,
    textures,
    lightmaps,
    dynamicLights: [],
    alias: [],
    sprites: [],
    particles: [],
  };
}

/** Model brush bounds for entity model `*N` (world = 0). */
export function bspModelBounds(map: BspMap, modelNum: number): { mins: Float32Array; maxs: Float32Array } {
  return {
    mins: new Float32Array([
      map.modelsMins[modelNum * 3]!,
      map.modelsMins[modelNum * 3 + 1]!,
      map.modelsMins[modelNum * 3 + 2]!,
    ]),
    maxs: new Float32Array([
      map.modelsMaxs[modelNum * 3]!,
      map.modelsMaxs[modelNum * 3 + 1]!,
      map.modelsMaxs[modelNum * 3 + 2]!,
    ]),
  };
}
