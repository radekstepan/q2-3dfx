// q2-bench RGB attribution (PERF-1): reproducible BEFORE/AFTER harness for
// PERF-2 (indexed/RGB + parallel RGB) and PERF-3 (reconstruction/pack/gamma).
//
// What it measures, per (resolution, scene, entity-set, mode):
//   - renderView GEO split via SoftwareRenderer.testMeasurePhases (setup /
//     mark / traverse / cull / cache / project / emit / sort — reused, no
//     renderer changes) + DRAW + alias phases, medians + p95 over N reps.
//   - Classic DRAW vs RGB spanfill WITHOUT touching the renderer: the
//     phases.draw counter lumps classic + RGB (frame.ts draws classic always,
//     RGB on top), so RGB_extra = draw(rgbOn) - draw(rgbOff) on the identical
//     scene/camera. Same for the alias phase (RGB twins + seed live there).
//     endFrame(rgbOn) - endFrame(rgbOff) ~= seed + composite (palette expand
//     is the common part). These are documented estimates, not probes.
//   - endFrame wall time (hrtime): palette expand [+ composite when armed].
//   - Voodoo resolve split on the real frame via live @q2/voodoo API with the
//     pinned vd_* profile: resolveRGB565 (pack+dither, gamma 1) vs
//     applyReconstruction2x2 (recon) vs applyDisplayGamma (gamma). This is a
//     harness-level cost probe on the produced frame — the renderer pipeline
//     itself ends at endFrame's expand+composite (no voodoo resolve inline).
//   - Hashes: index-plane FNV + color-plane R+G FNV (same scheme as the
//     frame.ts harness: R byte then G byte per pixel). Software planes are
//     bit-identical with the RGB flag on or off by construction.
// Modes: serial only (sw_workers=0, no pools), single-thread sequential.
// Fixed cameras: testkit base1Views() (time 1.5, fov 90, flat styles) +
// DEVROOM_CAMERA. Fixed cvars: vd profile gamma 1.3 / dither 1 / 16bit 1 /
// postfilter 1 / bilinear 1 / mipdither 1 / fog 1 / overbright 1 /
// palettetex 1 / maxtexsize 256 / zbits 16 / dithermode 4x4 /
// reconmode 2x2sub+2x2box / rgbmaxdelta 8,8,8.

import { readFileSync } from 'node:fs';
import { loadBsp } from '@q2/bsp';
import { resetCVars, setCVar, setCVarFromString } from '@q2/config';
import { parseMD2, parsePCX, parseWAL } from '@q2/formats';
import { createFramebuffer } from '@q2/renderer-api';
import type { Entity } from '@q2/renderer-api';
import {
  SoftwareRenderer, bspToMiniWorld, createDevroom,
  type BspTexelSource, type FramePhases, type MiniWorld,
} from '@q2/sw-renderer';
import { base1RefDef, base1Views, machineJson } from '@q2/testkit';
import {
  applyDisplayGamma, applyReconstruction2x2, readVoodooState, resolveRGB565,
} from '@q2/voodoo';

export const RGB_ATTR_RESS: Array<[number, number]> = [[320, 240], [640, 480]];
export const RGB_ATTR_SCENES = ['devroom', 'spawn-north', 'trench-east'] as const;
export type RgbAttrScene = (typeof RGB_ATTR_SCENES)[number];
export type RgbAttrEntities = 'none' | 'fixed';
export type RgbAttrMode = 'software' | 'rgb';

/** Fixed vd_* + sw_* profile for every PERF-1 run (serial, voodoo look). */
export function pinPerfCvars(): void {
  resetCVars();
  setCVar('sw_workers', 0);
  setCVar('sw_accum', 0);
  setCVar('vd_gamma', 1.3);
  setCVar('vd_dither', 1);
  setCVar('vd_16bit', 1);
  setCVar('vd_postfilter', 1);
  setCVar('vd_bilinear', 1);
  setCVar('vd_mipdither', 1);
  setCVar('vd_lodbias', -0.35);
  setCVar('vd_fog', 1);
  setCVar('vd_overbright', 1);
  setCVar('vd_palettetex', 1);
  setCVar('vd_maxtexsize', 256);
  setCVar('vd_zbits', 16);
  setCVarFromString('vd_dithermode', '4x4');
  setCVarFromString('vd_reconmode', '2x2sub+2x2box');
  setCVarFromString('vd_rgbmaxdelta', '8,8,8');
}

function pakReadFile(pakPath: string, name: string): ArrayBuffer {
  const data = readFileSync(pakPath);
  if (data.subarray(0, 4).toString() !== 'PACK') throw new Error('not a pak file');
  const dirofs = data.readUInt32LE(4);
  const dirlen = data.readUInt32LE(8);
  for (let o = dirofs; o < dirofs + dirlen; o += 64) {
    const entry = data.subarray(o, o + 56).toString().replace(/\0.*$/, '');
    if (entry === name) {
      const off = data.readUInt32LE(o + 56);
      const len = data.readUInt32LE(o + 60);
      return data.buffer.slice(data.byteOffset + off, data.byteOffset + off + len) as ArrayBuffer;
    }
  }
  throw new Error(`pak entry missing: ${name}`);
}

export interface RgbAttrWorld {
  world: MiniWorld;
  palette: Uint8Array;
  soldierMd2: ArrayBuffer;
  soldierSkin: { pixels: Uint8Array; width: number; height: number };
}

/** Load base1.bsp + WAL texels + colormap + soldier MD2/skin (once per process). */
export function loadRgbAttrWorld(pakPath: string): RgbAttrWorld {
  const bsp = loadBsp(pakReadFile(pakPath, 'maps/base1.bsp'));
  const walCache = new Map<string, BspTexelSource | null>();
  const texelFor = (walName: string): BspTexelSource | null => {
    if (walCache.has(walName)) return walCache.get(walName)!;
    let src: BspTexelSource | null = null;
    try {
      const wal = parseWAL(pakReadFile(pakPath, `textures/${walName}.wal`));
      src = { texels: wal.mips[0] as Uint8Array, width: wal.width, height: wal.height };
    } catch { src = null; }
    walCache.set(walName, src);
    return src;
  };
  const skin = parsePCX(pakReadFile(pakPath, 'models/monsters/soldier/skin.pcx'));
  return {
    world: bspToMiniWorld(bsp, { texelFor }),
    palette: parsePCX(pakReadFile(pakPath, 'pics/colormap.pcx')).palette,
    soldierMd2: pakReadFile(pakPath, 'models/monsters/soldier/tris.md2'),
    soldierSkin: { pixels: skin.pixels, width: skin.width, height: skin.height },
  };
}

/**
 * Fixed entity set, placed relative to the camera so it lands in-frustum on
 * every scene: 1 alias (real soldier MD2), 1 sprite (sp2, soldier skin as the
 * sprite texture), 1 tracer beam across the view. Particles ride in the
 * MiniWorld copy (base1 only — devroom's procedural world is shared).
 */
export function fixedEntities(
  r: SoftwareRenderer, fw: RgbAttrWorld,
  origin: [number, number, number], yawDeg: number,
): Entity[] {
  const yaw = (yawDeg * Math.PI) / 180;
  const fx = Math.cos(yaw), fy = Math.sin(yaw);
  const rx = -fy, ry = fx;
  const [ox, oy, oz] = origin;
  const md2 = parseMD2(fw.soldierMd2.slice(0));
  const mh = r.registerModel({ name: 'soldier', kind: 'md2', data: md2 });
  const sh = r.registerSkinPixels('soldier-skin', fw.soldierSkin.pixels, fw.soldierSkin.width, fw.soldierSkin.height);
  const th = r.registerModel({ name: 'tracer', kind: 'tracer' as unknown as 'sp2', data: null });
  const sx = ox + fx * 48, sy = oy + fy * 48;
  const sp2 = r.registerModel({ name: 'shot-sprite', kind: 'sp2', data: null });
  return [
    {
      model: mh, origin: new Float32Array([sx, sy, oz - 30]),
      angles: new Float32Array([0, yawDeg + 180, 0]), frame: 4, skin: sh,
    },
    {
      model: sp2, origin: new Float32Array([sx, sy, oz + 18]),
      angles: new Float32Array([0, 0, 0]), frame: 0, skin: sh,
    },
    {
      model: th,
      origin: new Float32Array([ox + fx * 40 + rx * 25, oy + fy * 40 + ry * 25, oz - 10]),
      angles: new Float32Array([0, yawDeg + 90, 0]), frame: 96, skin: 231,
    },
  ];
}

/** 12-particle spark cloud around (cx, cy, cz) for the MiniWorld copy. */
function sparkParticles(cx: number, cy: number, cz: number): MiniWorld['particles'] {
  const colors = [8, 70, 200, 231, 250, 180, 33, 99, 150, 210, 240, 15];
  return colors.map((color, i) => ({
    origin: new Float32Array([cx + ((i * 37) % 17) - 8, cy + ((i * 53) % 17) - 8, cz + 10 + ((i * 29) % 25)]),
    color,
  }));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
}

/** Index-plane FNV-1a (matches the frame.ts harness hashIdx). */
function hashIdx(idx: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < idx.length; i++) {
    h ^= idx[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Color-plane R+G FNV-1a (matches the frame.ts harness hashColor). */
function hashColorRG(color: Uint32Array): string {
  let h = 2166136261;
  for (let i = 0; i < color.length; i++) {
    h ^= color[i]! & 0xff;
    h = Math.imul(h, 16777619);
    h ^= (color[i]! >>> 8) & 0xff;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface AttrRow {
  scene: string;
  res: string;
  entities: RgbAttrEntities;
  mode: RgbAttrMode;
  renderViewMs: number;
  renderViewP95: number;
  geoMs: number;
  setup: number; mark: number; traverse: number; cull: number;
  cache: number; project: number; emit: number; sort: number;
  drawMs: number; drawP95: number;
  aliasMs: number;
  endFrameMs: number; endFrameP95: number;
  packMs: number | null; reconMs: number | null; gammaMs: number | null;
  spans: number; pixels: number; overdraw: number;
  idxHash: string; colorHash: string;
}

function runConfig(
  fw: RgbAttrWorld, scene: RgbAttrScene, W: number, H: number,
  ent: RgbAttrEntities, mode: RgbAttrMode, warmup: number, reps: number,
): AttrRow {
  pinPerfCvars();
  const rgb = mode === 'rgb';
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(fw.palette);
  // The RGB switch is a shared module flag: set it explicitly EVERY config
  // (a previous rgb config would otherwise leak into the next "software"
  // row — caught by the idx/color cross-check below).
  r.setRGBWorldEnabled(rgb);

  let view, worldData: MiniWorld, worldName: string;
  let entOrigin: [number, number, number], entYaw: number;
  if (scene === 'devroom') {
    worldData = createDevroom();
    worldName = 'devroom';
    entOrigin = [-168, 0, 136];
    entYaw = 0;
    view = {
      origin: new Float32Array(entOrigin),
      angles: new Float32Array([0, 0, 0]),
      fovX: 90, time: 1.5, lightStyles: new Float32Array(256).fill(1),
    };
  } else {
    const bv = base1Views().find((v) => v.label === scene)!;
    view = base1RefDef(bv);
    worldName = 'base1';
    entOrigin = bv.origin;
    entYaw = bv.angles[1]!;
    worldData = fw.world;
  }
  const entities: Entity[] = ent === 'fixed' ? fixedEntities(r, fw, entOrigin, entYaw) : [];
  let data: MiniWorld = worldData;
  if (ent === 'fixed' && scene !== 'devroom') {
    const [ox, oy, oz] = entOrigin;
    const yaw = (entYaw * Math.PI) / 180;
    data = {
      ...worldData,
      particles: sparkParticles(ox + Math.cos(yaw) * 48, oy + Math.sin(yaw) * 48, oz - 20),
    };
  }
  const worldArg = { name: worldName, data };

  for (let i = 0; i < warmup; i++) { r.beginFrame(); r.renderView(view, worldArg, entities); r.endFrame(); }
  const acc: Record<keyof FramePhases, number[]> = {
    setup: [], mark: [], traverse: [], cull: [], cache: [],
    project: [], emit: [], sort: [], draw: [], alias: [],
  };
  const rv: number[] = [];
  const ef: number[] = [];
  let spans = 0, pixels = 0, overdraw = 0;
  for (let i = 0; i < reps; i++) {
    // Wall renderView with hrtime (stats.ms is Date.now-coarse): covers the
    // beginFrame + renderView inside testMeasurePhases; endFrame timed below.
    const rt = process.hrtime.bigint();
    const m = r.testMeasurePhases(view, worldArg, entities);
    rv.push(Number(process.hrtime.bigint() - rt) / 1e6);
    spans = m.stats.spans; pixels = m.stats.pixels; overdraw = m.stats.overdraw;
    for (const k of Object.keys(acc) as (keyof FramePhases)[]) acc[k]!.push(m.phases[k]);
    const t = process.hrtime.bigint();
    r.endFrame();
    ef.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const med = (xs: number[]): number => median(xs);
  const medAcc = (k: keyof FramePhases): number => med(acc[k]);
  const geo = medAcc('setup') + medAcc('mark') + medAcc('traverse') + medAcc('cull') +
    medAcc('cache') + medAcc('project') + medAcc('emit') + medAcc('sort');

  // Voodoo resolve split on the produced frame (harness-level probe): the
  // endFrame above already composited RGB565-expanded pixels into color, so
  // resolve from that plane with the pinned vd profile (gamma 1 pack, then
  // recon, then display gamma).
  let packMs: number | null = null, reconMs: number | null = null, gammaMs: number | null = null;
  if (rgb) {
    const st = readVoodooState();
    const src = r.getFramebuffer().color.slice();
    const dst565 = new Uint16Array(W * H);
    const display = new Uint32Array(W * H);
    const pk: number[] = [], rc: number[] = [], gm: number[] = [];
    for (let i = 0; i < reps; i++) {
      let t = process.hrtime.bigint();
      resolveRGB565(src, dst565, W, H, { gamma: 1, dither: st.dither, ditherMode: st.dithermode, quantise: st.quantise });
      pk.push(Number(process.hrtime.bigint() - t) / 1e6);
      t = process.hrtime.bigint();
      applyReconstruction2x2(dst565, display, W, H, st.rgbmaxdelta, st.dither ? '2x2' : null);
      rc.push(Number(process.hrtime.bigint() - t) / 1e6);
      t = process.hrtime.bigint();
      applyDisplayGamma(display, W, H, st.gamma);
      gm.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    packMs = med(pk); reconMs = med(rc); gammaMs = med(gm);
  }

  const g = r.getFramebuffer();
  const row: AttrRow = {
    scene, res: `${W}x${H}`, entities: ent, mode,
    renderViewMs: med(rv), renderViewP95: p95(rv), geoMs: geo,
    setup: medAcc('setup'), mark: medAcc('mark'), traverse: medAcc('traverse'),
    cull: medAcc('cull'), cache: medAcc('cache'), project: medAcc('project'),
    emit: medAcc('emit'), sort: medAcc('sort'),
    drawMs: medAcc('draw'), drawP95: p95(acc.draw), aliasMs: medAcc('alias'),
    endFrameMs: med(ef), endFrameP95: p95(ef),
    packMs, reconMs, gammaMs,
    spans, pixels, overdraw,
    idxHash: hashIdx(g.index!), colorHash: hashColorRG(g.color),
  };
  const rs = (v: number | null): string => v === null ? '—' : v.toFixed(2);
  console.log(
    `${row.scene} ${row.res} ent=${ent} ${mode}: ` +
    `renderView=${row.renderViewMs.toFixed(2)}(p95 ${row.renderViewP95.toFixed(2)}) ` +
    `GEO=${geo.toFixed(2)} DRAW=${row.drawMs.toFixed(2)}(p95 ${row.drawP95.toFixed(2)}) ` +
    `alias=${row.aliasMs.toFixed(2)} endFrame=${row.endFrameMs.toFixed(2)}(p95 ${row.endFrameP95.toFixed(2)}) ` +
    `pack=${rs(packMs)} recon=${rs(reconMs)} gamma=${rs(gammaMs)} ` +
    `spans=${spans} px=${pixels} ov=${overdraw.toFixed(2)} ` +
    `idx=${row.idxHash} color=${row.colorHash}`,
  );
  return row;
}

export interface RgbAttrOptions {
  warmup?: number;
  reps?: number;
  scenes?: RgbAttrScene[];
}

/** Full PERF-1 BEFORE run: both resolutions × devroom + 2 base1 views × none/fixed × software/RGB. */
export async function runRgbAttr(pakPath: string, opts: RgbAttrOptions = {}): Promise<{ rows: AttrRow[]; machine: unknown; commit: string }> {
  const warmup = opts.warmup ?? 3;
  const reps = opts.reps ?? 10;
  const scenes = opts.scenes ?? [...RGB_ATTR_SCENES];
  const fw = loadRgbAttrWorld(pakPath);
  console.log(`rgb attribution: base1 surfaces=${fw.world.surfaces.length} warmup=${warmup} reps=${reps} serial sw_workers=0`);
  console.log('cvars: vd_gamma=1.3 vd_dither=1 vd_16bit=1 vd_postfilter=1 vd_bilinear=1 vd_mipdither=1 vd_fog=1 vd_overbright=1 vd_palettetex=1 vd_maxtexsize=256 vd_zbits=16 vd_dithermode=4x4 vd_reconmode=2x2sub+2x2box vd_rgbmaxdelta=8,8,8');
  const rows: AttrRow[] = [];
  for (const [W, H] of RGB_ATTR_RESS) {
    for (const scene of scenes) {
      for (const ent of ['none', 'fixed'] as const) {
        for (const mode of ['software', 'rgb'] as const) {
          rows.push(runConfig(fw, scene, W, H, ent, mode, warmup, reps));
        }
      }
    }
  }
  let commit = 'unknown';
  try {
    const cp = await import('child_process');
    commit = cp.execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch { /* offline */ }
  const machine = await machineJson().catch(() => ({ node: process.version }));
  // Cross-mode self-check per (scene, res, entities): software planes must be
  // bit-identical with the RGB flag on or off (idx equal); the RGB composite
  // must change at least one pixel (color differs) or the overlay drew
  // nothing and the row is not a real RGB run.
  for (let i = 0; i < rows.length; i += 2) {
    const a = rows[i]!;
    const b = rows[i + 1]!;
    const idxOk = a.idxHash === b.idxHash;
    const colorDiff = a.colorHash !== b.colorHash;
    console.log(
      `check ${a.scene} ${a.res} ent=${a.entities}: ` +
      `idx ${a.mode}=${b.mode} ${idxOk ? 'IDENTICAL' : `MISMATCH ${a.idxHash} vs ${b.idxHash}`} / ` +
      `color ${colorDiff ? 'DIFFERS (overlay drew)' : 'IDENTICAL (overlay drew nothing?)'}`,
    );
  }
  console.log(JSON.stringify({ machine, node: process.version, commit, warmup, reps }, null, 2));
  return { rows, machine, commit };
}
