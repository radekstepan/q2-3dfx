// @q2/testkit — PROOF-4 boxes 3-4: Node-side CPU reference render for the
// GPU-vs-CPU fixed-scene comparison.
//
// Renders the F1 combat frame through the CPU path (SoftwareRenderer serial,
// pinned cvars) and packs/visualizes captures. Reuses the committed
// fixtures (bench-workloads entity/light/particle placement,
// gpu-proof route/view/pump, GPU_PROOF_TOLERANCES gate). The render path
// mirrors gpu-proof.test.ts renderGpuProofFrame for the combat frame —
// duplicated here (not imported from the .test.ts file) so importing this
// module never re-registers that file's suites. The injected-writer pattern
// is not used here: fs writes happen in the calling test file.
//
// RELEASE-8: the legacy CPU Voodoo resolve leg is retired. The display
// plane is the raw-color software plane (a copy of the raster color
// plane); there is no voodoo-resolve oracle. GPU_PROOF_TOLERANCES are
// unchanged (no silent loosening).

import { createFramebuffer } from '@q2/renderer-api';
import { resetCVars } from '@q2/config';
import { SoftwareRenderer } from '@q2/sw-renderer';
import {
  loadBenchWorld,
  pinBenchCvars,
  withBenchParticles,
  type BenchWorld,
} from './bench-workloads.js';
import {
  GPU_PROOF_HEIGHT,
  GPU_PROOF_TOLERANCES,
  GPU_PROOF_WIDTH,
  compareGpuProofFrames,
  formatGpuProofReport,
  gpuProofEntitiesFor,
  gpuProofPumpFor,
  gpuProofRoute,
  gpuProofViewFor,
  type GpuProofTolerances,
} from './gpu-proof.js';
import { fnvColorFull } from './frame-evidence.js';

/** CPU reference for one proof frame (F1 combat). */
export interface GpuProofCpuRender {
  /** Raster color plane (0xAABBGGRR). */
  color: Uint32Array;
  /** Display plane: raw-color software copy of the raster plane (0xAABBGGRR). */
  display: Uint32Array;
  /** Which leg produced the display plane (RELEASE-8: raw-color only). */
  displayKind: 'raw-color';
  colorHash: string;
  displayHash: string;
}

/** Load the bench world from a pak ArrayBuffer (mirrors gpu-proof.test.ts). */
export function loadCpuProofWorld(pakBytes: ArrayBuffer): BenchWorld {
  return loadBenchWorld(pakBytes);
}

/**
 * Render the F1 combat frame serially under the pinned profile (fresh
 * renderer, combat particles, pumped dlights; raw-color display leg).
 * Resets cvars + RGB-world mode afterwards (no leakage into sibling tests).
 */
export async function renderCpuProofF1(bw: BenchWorld): Promise<GpuProofCpuRender> {
  pinBenchCvars();
  const W = GPU_PROOF_WIDTH, H = GPU_PROOF_HEIGHT;
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  try {
    r.init(fb);
    r.setPalette(bw.palette);
    const frame = gpuProofRoute()[1]!;
    const origin: [number, number, number] = [128, -320, 54];
    const yawRad = (frame.yawDeg * Math.PI) / 180;
    const world = {
      name: 'base1',
      data: withBenchParticles(
        bw.world,
        origin[0] + Math.cos(yawRad) * 48,
        origin[1] + Math.sin(yawRad) * 48,
        origin[2] - 20,
      ),
    };
    const entities = gpuProofEntitiesFor(r, bw, frame);
    gpuProofPumpFor(r, origin, frame.yawDeg, frame);
    r.beginFrame();
    r.renderView(gpuProofViewFor(frame), world, entities);
    r.endFrame();
    const color = fb.color.slice();
    // RELEASE-8: raw-color software plane only — the legacy CPU Voodoo
    // resolve leg is retired, never attempted here.
    const display = color.slice();
    const displayKind: 'raw-color' = 'raw-color';
    return {
      color,
      display,
      displayKind,
      colorHash: fnvColorFull(color),
      displayHash: fnvColorFull(display),
    };
  } finally {
    resetCVars();
  }
}

/**
 * Pack page readPixels bytes (RGBA order) into the 0xAABBGGRR layout the
 * CPU planes and compareGpuProofFrames use.
 */
export function packRgbaBytesToAbgr(px: Uint8Array): Uint32Array {
  const n = Math.floor(px.length / 4);
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const rr = px[o]!, gg = px[o + 1]!, bb = px[o + 2]!, aa = px[o + 3]!;
    out[i] = ((aa << 24) | (bb << 16) | (gg << 8) | rr) >>> 0;
  }
  return out;
}

/** Strip alpha: RGBA bytes → packed RGB bytes (PPM body). */
export function rgbaToRgb(px: Uint8Array): Uint8Array {
  const n = Math.floor(px.length / 4);
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const s = i * 4, d = i * 3;
    out[d] = px[s]!;
    out[d + 1] = px[s + 1]!;
    out[d + 2] = px[s + 2]!;
  }
  return out;
}

/** 0xAABBGGRR plane → packed RGB bytes (PPM body). */
export function abgrToRgb(plane: Uint32Array): Uint8Array {
  const out = new Uint8Array(plane.length * 3);
  for (let i = 0; i < plane.length; i++) {
    const v = plane[i]!;
    const d = i * 3;
    out[d] = v & 255;
    out[d + 1] = (v >> 8) & 255;
    out[d + 2] = (v >> 16) & 255;
  }
  return out;
}

/**
 * Build a review-visualization RGB body with the SAME semantics as
 * compareGpuProofFrames (per-channel LSB forgiveness + edge exclusion):
 * diff pixels → pure red, edge-excluded border → mid gray, matches → the
 * GPU pixel at half brightness.
 */
export function buildDiffRgb(
  gpu: Uint8Array,
  cpu: Uint32Array,
  width: number,
  height: number,
  tolerances: GpuProofTolerances = GPU_PROOF_TOLERANCES,
): Uint8Array {
  const lsb = tolerances.perChannelLsb;
  const edge = Math.max(0, Math.floor(tolerances.edgeExcludePx));
  const n = width * height;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const d = i * 3;
    const x = i % width;
    const y = Math.floor(i / width);
    if (x < edge || y < edge || x >= width - edge || y >= height - edge) {
      out[d] = 128;
      out[d + 1] = 128;
      out[d + 2] = 128;
      continue;
    }
    const o = i * 4;
    const gr = gpu[o]!, gg = gpu[o + 1]!, gb = gpu[o + 2]!;
    const c = i < cpu.length ? cpu[i]! : 0;
    const cr = c & 255, cg = (c >> 8) & 255, cb = (c >> 16) & 255;
    if (Math.abs(gr - cr) <= lsb && Math.abs(gg - cg) <= lsb && Math.abs(gb - cb) <= lsb) {
      out[d] = gr >> 1;
      out[d + 1] = gg >> 1;
      out[d + 2] = gb >> 1;
    } else {
      out[d] = 255;
      out[d + 1] = 0;
      out[d + 2] = 0;
    }
  }
  return out;
}

/** Encode a binary P6 PPM (viewable review artifact, no decoder needed). */
export function encodePpm(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const head = `P6\n# q2ts gpu-proof-4 review\n${width} ${height}\n255\n`;
  const hb = new TextEncoder().encode(head);
  const out = new Uint8Array(hb.length + rgb.length);
  out.set(hb, 0);
  out.set(rgb, hb.length);
  return out;
}

/** Format the F1-vs-CPU gate line (pass-through to the predeclared reporter). */
export function formatF1GateReport(
  diff: ReturnType<typeof compareGpuProofFrames>,
): string {
  return formatGpuProofReport('f1-gpu-vs-cpu', diff, GPU_PROOF_TOLERANCES);
}
