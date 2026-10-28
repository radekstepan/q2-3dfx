// @q2/testkit — working voodoo baseline (no-HW-calibration milestone).
//
// What this is: deterministic synthetic fixtures (flat, ramp, checker,
// red/blue lit wall, transparent hole, high-contrast edge) plus one
// procedural devroom render through the Refresh serial path, each resolved
// in BOTH capture stages — raw RGB565 (565 pack + per-pixel expand, no
// reconstruction) and reconstructed (legacy 2x2 box scanout) — at fixed
// 640x480. Every capture ships with profile settings JSON (all vd_* +
// dithermode/reconmode/rgbmaxdelta + renderer revision + map/camera/sim
// time + stage label). See VOODOO_BASELINE_APPROXIMATIONS.md for the
// manual-sourced vs chosen-approx split.
//
// Deliberate duplication, not imports: the gamma LUT, Bayer tables,
// quantise/expand and 2x2 box below PIN the voodoo resolve behaviour as of
// base 5e13d42 so this baseline stays stable while parallel lanes evolve
// packages/voodoo internals. The voodoo test cross-checks the live package
// only via optional dynamic import (feature detection) and asserts stable
// properties, never exact-output equality.
//
// No retail assets: every scene is procedural (maps/devroom cameras from
// demo-fallback.ts); Q2_PAK is never touched.

import type { RefDef } from '@q2/renderer-api';
import { NullRefresh, createFramebuffer } from '@q2/renderer-api';
import { DEMO_FALLBACK_MAP, demoFallbackViews } from './demo-fallback.js';

/** Fixed capture resolution (astra guide §4: first capture at 640x480). */
export const BASELINE_WIDTH = 640;
/** Fixed capture resolution (astra guide §4: first capture at 640x480). */
export const BASELINE_HEIGHT = 480;

/** Capture stages recorded per scene (raw-565 vs reconstructed vs display). */
export type BaselineStage = 'raw-565' | 'reconstructed' | 'display';

/**
 * Duplicated voodoo profile (values mirror packages/config vd_* defaults
 * and packages/voodoo defaultVoodooState() at base 5e13d42 — duplicated by
 * value, never imported, so parallel voodoo lanes cannot move this file).
 */
export interface BaselineProfile {
  vd_16bit: number;
  vd_dither: number;
  vd_postfilter: number;
  vd_bilinear: number;
  vd_mipdither: number;
  vd_lodbias: number;
  vd_fog: number;
  vd_gamma: number;
  vd_maxtexsize: number;
  vd_zbits: number;
  vd_palettetex: number;
  vd_overbright: number;
  vd_dithermode: string;
  vd_reconmode: string;
  vd_rgbmaxdelta: string;
}

/** Pinned profile const: the working-baseline capture settings. */
export function baselineProfile(): BaselineProfile {
  return {
    vd_16bit: 1,
    vd_dither: 1,
    vd_postfilter: 1,
    vd_bilinear: 1,
    vd_mipdither: 1,
    vd_lodbias: -0.35,
    vd_fog: 1,
    vd_gamma: 1.3,
    vd_maxtexsize: 256,
    vd_zbits: 16,
    vd_palettetex: 1,
    vd_overbright: 1,
    vd_dithermode: '4x4',
    vd_reconmode: 'legacy',
    vd_rgbmaxdelta: '0,0,0',
  };
}

// --- Pinned resolve (duplicates voodoo resolve.ts at base 5e13d42) ---------

/** Glide gamma lift LUT: lut[i] = round(255 * (i/255)^(1/gamma)). */
export function baselineGammaLUT(gamma: number): Uint8Array {
  const lut = new Uint8Array(256);
  const inv = 1 / gamma;
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.min(255, Math.round(255 * Math.pow(i / 255, inv)));
  }
  return lut;
}

/** Canonical 4x4 Bayer matrix, row-major, values 0..15. */
const BAYER4 = new Uint8Array([
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
]);

/** Pre-quantise dither offsets: round((b - 7.5) * amp / 8). */
function buildOffset(amp: number): Int8Array {
  const t = new Int8Array(16);
  for (let p = 0; p < 16; p++) t[p] = Math.round((BAYER4[p]! - 7.5) * amp / 8);
  return t;
}

const DITHER_RB = buildOffset(4);
const DITHER_G = buildOffset(2);

/** Pack 8:8:8 into RGB565 (truncate). Mirrors quantiseRGB565. */
export function baselineQuantise565(r: number, g: number, b: number): number {
  return ((((r & 0xf8) << 8) | ((g & 0xfc) << 3) | ((b & 0xf8) >> 3)) & 0xffff);
}

/** Expand RGB565 to 0xFFBBGGRR with bit replication. Mirrors expandRGB565. */
export function baselineExpand565(v: number): number {
  const r5 = (v >> 11) & 31;
  const g6 = (v >> 5) & 63;
  const b5 = v & 31;
  const r = (r5 << 3) | (r5 >> 2);
  const g = (g6 << 2) | (g6 >> 4);
  const b = (b5 << 3) | (b5 >> 2);
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

/** FNV-1a hex of a color plane (same algorithm as testkit hashFrame). */
export function hashBaseline(color: Uint32Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < color.length; i++) {
    h ^= color[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 8:8:8 source -> RGB565 target (gamma LUT, 4x4 ordered dither, truncate). */
export function baselineResolve565(src: Uint32Array, w: number, h: number, gamma: number): Uint16Array {
  const lut = baselineGammaLUT(gamma);
  const dst = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const rowPh = (y & 3) << 2;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const px = src[i]!;
      const p = rowPh | (x & 3);
      let r = lut[px & 255]! + DITHER_RB[p]!;
      let g = lut[(px >> 8) & 255]! + DITHER_G[p]!;
      let b = lut[(px >> 16) & 255]! + DITHER_RB[p]!;
      r = r < 0 ? 0 : r > 255 ? 255 : r;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      b = b < 0 ? 0 : b > 255 ? 255 : b;
      dst[i] = baselineQuantise565(r, g, b);
    }
  }
  return dst;
}

/**
 * Raw-565 stage: 565 pack, then per-pixel expand (postfilter OFF semantics —
 * every pixel rewritten, never stale).
 */
export function resolveRaw565Display(src: Uint32Array, w: number, h: number, gamma: number): Uint32Array {
  const packed = baselineResolve565(src, w, h, gamma);
  const out = new Uint32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = baselineExpand565(packed[i]!);
  return out;
}

/**
 * Reconstructed stage: legacy scanout — unconditional 2x2 box average of
 * the expanded 565 taps, clamp-to-edge, (sum + 2) >> 2 per channel.
 */
export function resolveReconstructedDisplay(
  src: Uint32Array,
  w: number,
  h: number,
  gamma: number,
): Uint32Array {
  const packed = baselineResolve565(src, w, h, gamma);
  const out = new Uint32Array(w * h);
  const expand = (v: number): [number, number, number] => {
    const r5 = (v >> 11) & 31;
    const g6 = (v >> 5) & 63;
    const b5 = v & 31;
    return [(r5 << 3) | (r5 >> 2), (g6 << 2) | (g6 >> 4), (b5 << 3) | (b5 >> 2)];
  };
  for (let y = 0; y < h; y++) {
    const y1 = y + 1 < h ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const x1 = x + 1 < w ? x + 1 : x;
      const a = expand(packed[y * w + x]!);
      const b = expand(packed[y * w + x1]!);
      const c = expand(packed[y1 * w + x]!);
      const d = expand(packed[y1 * w + x1]!);
      const r = ((a[0] + b[0] + c[0] + d[0] + 2) >> 2) & 255;
      const g = ((a[1] + b[1] + c[1] + d[1] + 2) >> 2) & 255;
      const bl = ((a[2] + b[2] + c[2] + d[2] + 2) >> 2) & 255;
      out[y * w + x] = (0xff000000 | (bl << 16) | (g << 8) | r) >>> 0;
    }
  }
  return out;
}

// --- Deterministic scenes ---------------------------------------------------

const pack = (r: number, g: number, b: number): number =>
  ((0xff000000 | (b << 16) | (g << 8) | r) >>> 0);

/** Flat mid-gray field: reconstruction must agree within one 565 quantum. */
function paintFlat(w: number, h: number): Uint32Array {
  const out = new Uint32Array(w * h);
  out.fill(pack(128, 128, 128));
  return out;
}

/** Smooth RGB ramps: dither-sensitive gradient the recon stage must melt. */
function paintRamp(w: number, h: number): Uint32Array {
  const out = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = Math.round((x * 255) / (w - 1));
      const g = Math.round((y * 255) / (h - 1));
      const b = Math.round(((x + y) * 255) / (w + h - 2));
      out[y * w + x] = pack(r, g, b);
    }
  }
  return out;
}

/** Receding checker plane: finest (1px) at top, coarsest (8px) at bottom. */
function paintChecker(w: number, h: number): Uint32Array {
  const out = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    const k = Math.min(3, (y * 4) / h | 0);
    for (let x = 0; x < w; x++) {
      const cell = (((x >> k) + (y >> k)) & 1) === 0;
      const v = cell ? 235 : 16;
      out[y * w + x] = pack(v, v, v);
    }
  }
  return out;
}

/** Neutral wall with red-lit left patch and blue-lit right patch. */
function paintLitwall(w: number, h: number): Uint32Array {
  const out = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = x / w;
      const wl = Math.min(1, Math.max(0, (0.38 - t) / 0.08));
      const wr = Math.min(1, Math.max(0, (t - 0.62) / 0.08));
      const rest = Math.max(0, 1 - wl - wr);
      const r = Math.round(128 * rest + 200 * wl + 60 * wr);
      const g = Math.round(128 * rest + 60 * wl + 80 * wr);
      const b = Math.round(128 * rest + 60 * wl + 200 * wr);
      out[y * w + x] = pack(r, g, b);
    }
  }
  return out;
}

/** Opaque field with an alpha-tested cutout hole showing the backdrop. */
function paintHole(w: number, h: number): Uint32Array {
  const out = new Uint32Array(w * h);
  out.fill(pack(160, 160, 160));
  const x0 = w / 2 - 80;
  const x1 = w / 2 + 80;
  const y0 = h / 2 - 60;
  const y1 = h / 2 + 60;
  for (let y = Math.floor(y0) - 1; y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0) - 1; x <= Math.ceil(x1); x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const inside = x >= x0 && x < x1 && y >= y0 && y < y1;
      const ring =
        !inside &&
        x >= x0 - 1 && x < x1 + 1 && y >= y0 - 1 && y < y1 + 1;
      if (inside) out[y * w + x] = pack(0, 192, 0);
      else if (ring) out[y * w + x] = pack(255, 255, 255);
    }
  }
  return out;
}

/** Smooth gradient ending in a 1px black edge, then a flat field. */
function paintEdge(w: number, h: number): Uint32Array {
  const out = new Uint32Array(w * h);
  const split = (w / 2) | 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v: number;
      if (x < split - 1) v = Math.round((x * 255) / (split - 1));
      else if (x === split - 1) v = 0;
      else v = 128;
      out[y * w + x] = pack(v, v, v);
    }
  }
  return out;
}

/** Procedural devroom through the Refresh serial path (NullRefresh). */
function paintDevroom(w: number, h: number, view: RefDef): Uint32Array {
  const r = new NullRefresh();
  r.init(createFramebuffer(w, h, false));
  r.beginFrame();
  r.renderView(view, { name: DEMO_FALLBACK_MAP, data: null }, []);
  r.endFrame();
  return r.getFramebuffer().color.slice();
}

export const BASELINE_SCENES = [
  'flat',
  'ramp',
  'checker',
  'litwall',
  'hole',
  'edge',
  'devroom',
] as const;

export type BaselineScene = (typeof BASELINE_SCENES)[number];

/** Paint a scene's 8:8:8 source buffer (deterministic, asset-free). */
export function paintBaselineScene(name: BaselineScene, w: number, h: number): Uint32Array {
  switch (name) {
    case 'flat': return paintFlat(w, h);
    case 'ramp': return paintRamp(w, h);
    case 'checker': return paintChecker(w, h);
    case 'litwall': return paintLitwall(w, h);
    case 'hole': return paintHole(w, h);
    case 'edge': return paintEdge(w, h);
    case 'devroom': {
      const views = demoFallbackViews();
      return paintDevroom(w, h, views[0]!.view);
    }
  }
}

/** Camera assigned to a scene (round-robin over demoFallbackViews). */
export function baselineCameraFor(index: number): { name: string; view: RefDef } {
  const views = demoFallbackViews();
  return views[index % views.length]!;
}

// --- Manifest ---------------------------------------------------------------

export interface BaselineStageEntry {
  hash: string;
  pixels: number;
}

export interface BaselineSceneEntry {
  scene: BaselineScene;
  map: string;
  camera: { name: string; origin: number[]; angles: number[]; fovX: number };
  simTime: number;
  resolution: { width: number; height: number };
  renderPath: 'serial';
  profile: BaselineProfile;
  renderer: { revision: string; resolve: 'pinned-duplicate@5e13d42' };
  stages: Record<BaselineStage, BaselineStageEntry>;
}

export interface BaselineManifest {
  generated: string;
  tool: '@q2/testkit voodoo-baseline';
  scenes: BaselineSceneEntry[];
}

/** Per-pixel stats between the two stages (review aid, not a gate). */
export function crossStageStats(
  raw: Uint32Array,
  recon: Uint32Array,
): { diffOver1Lsb: number; fraction: number; maxAbsDelta: number } {
  let diff = 0;
  let maxAbsDelta = 0;
  for (let i = 0; i < raw.length; i++) {
    const x = raw[i]!;
    const y = recon[i]!;
    if (x === y) continue;
    const dr = Math.abs((x & 255) - (y & 255));
    const dg = Math.abs(((x >> 8) & 255) - ((y >> 8) & 255));
    const db = Math.abs(((x >> 16) & 255) - ((y >> 16) & 255));
    const m = Math.max(dr, dg, db);
    if (m > maxAbsDelta) maxAbsDelta = m;
    if (m > 1) diff++;
  }
  return { diffOver1Lsb: diff, fraction: diff / raw.length, maxAbsDelta };
}

/**
 * Build the full in-memory baseline: paint + both resolves per scene.
 * Pure (no fs); the committed manifest stores hashes only, never pixels.
 */
export function generateBaseline(
  w: number = BASELINE_WIDTH,
  h: number = BASELINE_HEIGHT,
  head: string = 'unrecorded',
): { manifest: BaselineManifest; pixels: Record<string, Record<BaselineStage, Uint32Array>> } {
  const profile = baselineProfile();
  const pixels: Record<string, Record<BaselineStage, Uint32Array>> = {};
  const scenes: BaselineSceneEntry[] = BASELINE_SCENES.map((scene, i) => {
    const src = paintBaselineScene(scene, w, h);
    const { name, view } = baselineCameraFor(i);
    const raw = resolveRaw565Display(src, w, h, profile.vd_gamma);
    const recon = resolveReconstructedDisplay(src, w, h, profile.vd_gamma);
    // Display stage: legacy profile resolves display FROM the scanout
    // reconstruction (strict-HUD path would compose HUD pre-scanout; the
    // fixture carries no HUD by design — see APPROXIMATIONS §3).
    const display = recon.slice();
    pixels[scene] = { 'raw-565': raw, reconstructed: recon, display };
    return {
      scene,
      map: DEMO_FALLBACK_MAP,
      camera: {
        name,
        origin: Array.from(view.origin as ArrayLike<number>),
        angles: Array.from(view.angles as ArrayLike<number>),
        fovX: view.fovX,
      },
      simTime: view.time,
      resolution: { width: w, height: h },
      renderPath: 'serial' as const,
      profile,
      renderer: { revision: head, resolve: 'pinned-duplicate@5e13d42' as const },
      stages: {
        'raw-565': { hash: hashBaseline(raw), pixels: raw.length },
        reconstructed: { hash: hashBaseline(recon), pixels: recon.length },
        display: { hash: hashBaseline(display), pixels: display.length },
      },
    };
  });
  return {
    manifest: { generated: new Date().toISOString(), tool: '@q2/testkit voodoo-baseline', scenes },
    pixels,
  };
}

// --- Node-only regen writer (lazy fs import keeps the browser bundle clean) --

export const BASELINE_MANIFEST_DIR = 'baseline-manifests';
export const BASELINE_MANIFEST_FILE = 'voodoo-baseline.json';

/**
 * Regenerate on demand (`yarn workspace @q2/testkit baseline`): writes
 * `<outDir>/<scene>.<stage>.rgba` + per-scene JSON sidecars + the full
 * manifest into outDir (test-output, gitignored blobs), and refreshes the
 * COMMITTED hash manifest at committedManifestPath (hashes + settings
 * only, no pixels). All paths are plain strings (no import.meta here, so
 * the CJS build stays warning-free); the caller derives them from its own
 * location. Never runs during a plain test pass (gated on
 * VOODOO_BASELINE_WRITE=1 by the caller).
 */
export async function writeBaselineOutputs(
  outDir: string,
  committedManifestPath: string,
  head: string = 'unrecorded',
): Promise<{ manifestPath: string; files: string[] }> {
  const fs = await import('fs');
  const path = await import('path');
  const { manifest, pixels } = generateBaseline(BASELINE_WIDTH, BASELINE_HEIGHT, head);
  fs.mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  for (const entry of manifest.scenes) {
    for (const stage of ['raw-565', 'reconstructed', 'display'] as const) {
      const rgba = pixels[entry.scene]![stage];
      const base = path.join(outDir, `${entry.scene}.${stage}`);
      const bytes = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
      fs.writeFileSync(`${base}.rgba`, bytes);
      fs.writeFileSync(`${base}.json`, JSON.stringify(entry.stages[stage], null, 2));
      files.push(`${base}.rgba`, `${base}.json`);
    }
  }
  const manifestJson = JSON.stringify(manifest, null, 2);
  fs.writeFileSync(path.join(outDir, BASELINE_MANIFEST_FILE), manifestJson);
  files.push(path.join(outDir, BASELINE_MANIFEST_FILE));
  // Committed hash manifest (hashes + settings only, no pixels).
  fs.mkdirSync(path.join(committedManifestPath, '..'), { recursive: true });
  fs.writeFileSync(committedManifestPath, manifestJson);
  return { manifestPath: committedManifestPath, files };
}
