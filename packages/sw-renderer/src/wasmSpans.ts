// @q2/sw-renderer wasmSpans — M9.1 WASM spanfill backend (BRAIN.md scaling ladder step 5).
//
// Ports the `drawSpansSoftware` opaque-span hot loop (BRAIN.md §7.1, spans.ts)
// to a dependency-free WebAssembly module whose bytes are BUILT AT RUNTIME by
// the tiny emitter below. Rationale: this environment has no WASM toolchain
// (no AssemblyScript, wat2wasm, clangwasm, zig, emcc) and the package lock is
// frozen, so instead of a build-time toolchain the normative WAT-equivalent is
// encoded directly as structured bytecode. The emitter is ~150 lines, the
// kernel mirrors spans.ts op-for-op (f64/i32 semantics identical to JS), and
// byte-identity is enforced by differential fuzz tests (wasmSpans.test.ts).
//
// Design (hot loop only, geometry/front-end stays TS):
// - One `WebAssembly.Memory` per backend. The framebuffer `idx`/`zb` planes
//   ARE views over that memory (zero copy, zero per-frame allocation).
// - Per surface batch the TS side packs opaque spans into two flat arrays in
//   wasm memory (Float64 params + Int32 coords), copies the surface texels /
//   light block / colormap only when the backing reference changed, then
//   makes ONE wasm call for the whole batch (amortises the JS↔wasm hop).
// - Turbulent + flat spans stay in TS (`drawSpansTurbulent` /
//   `drawSpansFlatPerSpan`); flat spans are per-span colored (sky). Any
//   out-of-range input (oversize texture/block, too many spans, degenerate
//   output can never diverge — fallback IS the reference implementation.
// - Opt-in only: TS remains the default. Enable via the `sw_wasm` cvar (read
//   through @q2/config, registered lazily so no cross-package change) or
//   `SoftwareRenderer.setWasmEnabled(true)` after `initWasm()`.

import { Com_Error, featureEnabled, getCVarNumber, registerCVar } from '@q2/config';
import {
  SoftwareBackend,
  SPAN_OPAQUE,
  drawSpansSoftware,
  drawSpansTurbulent,
  drawSpansFlatPerSpan,
  textureMasks,
  type LightBlock,
  type SpanList,
  type Texture,
} from './spans.js';
import { COLORMAP_SIZE } from './colormap.js';

/** Cvar gating the WASM spanfill backend (default 0 = TS path). */
export const SW_WASM_CVAR = 'sw_wasm';

/** Max opaque spans per wasm batch; larger batches use the TS fallback. */
export const MAX_WASM_SPANS = 4096;

/**
 * Batches shading fewer pixels than this use the TS path: the JS→wasm
 * transition plus span packing costs more than the per-pixel win on tiny
 * batches (real frames issue ~10³ surface batches; the synth bench has one).
 */
export const MIN_WASM_PIXELS = 256;

/** Surface texel / light-block staging caps (bytes) inside wasm memory. */
const TEX_CAP = 65536; // 256x256, matches vd_maxtexsize
const LIGHT_CAP = 65536;

/** Doubles per packed span: iz diz uz duz vz dvz light dlight lu lv dlu. */
const F_PER_SPAN = 11;
/** Ints per packed span: y x0 x1. */
const I_PER_SPAN = 3;

/** True when the operator asked for the WASM backend (cvar or feature flag). */
export function wasmRequestedByCvar(): boolean {
  try {
    registerCVar(SW_WASM_CVAR, 0, 'use the WASM spanfill backend (M9.1, default 0 = TS)');
    return featureEnabled('wasmSpans') || getCVarNumber(SW_WASM_CVAR) !== 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// §1 Raw wasm emitter (no toolchain): enough of the binary format to encode
// three small functions (toI32, sampleLight, draw_opaque) + one memory import.
// ---------------------------------------------------------------------------

const OP = {
  block: 0x02, loop: 0x03, iff: 0x04, else: 0x05, end: 0x0b,
  br: 0x0c, brIf: 0x0d, call: 0x10,
  get: 0x20, set: 0x21,
  i32load: 0x28, f32load: 0x2a, f64load: 0x2b, i32load8u: 0x2d,
  i32store: 0x36, f32store: 0x38, i32store8: 0x3a,
  i32c: 0x41, f64c: 0x44,
  ieq: 0x46, ilts: 0x48, iltu: 0x49, igts: 0x4a, igtu: 0x4b,
  iles: 0x4c, iges: 0x4e, igeu: 0x4f,
  iadd: 0x6a, isub: 0x6b, imul: 0x6c, iand: 0x71, ishl: 0x74, sshr: 0x75,
  feq: 0x61, fne: 0x62, flt: 0x63, fgt: 0x64, fle: 0x65, fge: 0x66,
  ffloor: 0x9c, ftrunc: 0x9d,
  fadd: 0xa0, fsub: 0xa1, fmul: 0xa2, fdiv: 0xa3,
  i32truncF64s: 0xaa,
  f32demote: 0xb6, f64fromI32s: 0xb7, f64fromI32u: 0xb8, f64fromF32: 0xbb,
} as const;

function uleb(out: number[], v: number): void {
  v >>>= 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
}

function sleb(out: number[], v: number): void {
  v |= 0;
  for (;;) {
    let b = v & 0x7f;
    v >>= 7;
    const done = (v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0);
    if (!done) b |= 0x80;
    out.push(b);
    if (done) return;
  }
}

function f64bytes(out: number[], v: number): void {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true);
  for (let i = 0; i < 8; i++) out.push(b[i]!);
}

/** Structured-expression builder with a label stack (br depths computed). */
class Fn {
  readonly b: number[] = [];
  private labels: Array<string | null> = [];

  u(v: number): void { uleb(this.b, v); }
  i32c(v: number): void { this.b.push(OP.i32c); sleb(this.b, v); }
  f64c(v: number): void { this.b.push(OP.f64c); f64bytes(this.b, v); }
  g(i: number): void { this.b.push(OP.get); uleb(this.b, i); }
  s(i: number): void { this.b.push(OP.set); uleb(this.b, i); }
  ld8(off: number): void { this.b.push(OP.i32load8u, 0x00); uleb(this.b, off); }
  ld32(off: number): void { this.b.push(OP.i32load, 0x00); uleb(this.b, off); }
  f32ld(off: number): void { this.b.push(OP.f32load, 0x00); uleb(this.b, off); }
  f64ld(off: number): void { this.b.push(OP.f64load, 0x00); uleb(this.b, off); }
  st8(off: number): void { this.b.push(OP.i32store8, 0x00); uleb(this.b, off); }
  st32(off: number): void { this.b.push(OP.i32store, 0x00); uleb(this.b, off); }
  f32st(off: number): void { this.b.push(OP.f32store, 0x00); uleb(this.b, off); }
  op(o: number): void { this.b.push(o); }
  call(i: number): void { this.b.push(OP.call); uleb(this.b, i); }
  block(name: string): void { this.b.push(OP.block, 0x40); this.labels.push(name); }
  loop(name: string): void { this.b.push(OP.loop, 0x40); this.labels.push(name); }
  ifVoid(): void { this.b.push(OP.iff, 0x40); this.labels.push(null); }
  ifI32(): void { this.b.push(OP.iff, 0x7f); this.labels.push(null); }
  else_(): void { this.b.push(OP.else); }
  end(): void {
    if (this.labels.length === 0) throw new Error('wasm: end with empty label stack');
    this.labels.pop();
    this.b.push(OP.end);
  }
  private depthOf(name: string): number {
    let d = 0;
    for (let k = this.labels.length - 1; k >= 0; k--) {
      if (this.labels[k] === name) return d;
      d++;
    }
    throw new Error(`wasm: unknown label ${name}`);
  }
  br(name: string): void { this.b.push(OP.br); uleb(this.b, this.depthOf(name)); }
  brIf(name: string): void { this.b.push(OP.brIf); uleb(this.b, this.depthOf(name)); }
  get depth(): number { return this.labels.length; }
}

function makeFunc(
  i32locals: number, f64locals: number, body: (f: Fn) => void,
): number[] {
  const f = new Fn();
  body(f);
  if (f.depth !== 0) throw new Error('wasm: unbalanced blocks');
  const out: number[] = [];
  const groups = (i32locals > 0 ? 1 : 0) + (f64locals > 0 ? 1 : 0);
  uleb(out, groups);
  if (i32locals > 0) { uleb(out, i32locals); out.push(0x7f); }
  if (f64locals > 0) { uleb(out, f64locals); out.push(0x7c); }
  const code = [...out, ...f.b, OP.end];
  const sized: number[] = [];
  uleb(sized, code.length);
  return [...sized, ...code];
}

// toI32(x: f64) -> i32 — exact JS `x | 0` (ToInt32) for |trunc(x)| < 2^53,
// which covers every value the span loop can produce (near plane z >= 4
// bounds u/v; light grades are 0..63). NaN -> 0, like JS.
function emitToI32(): number[] {
  return makeFunc(0, 3, (f) => {
    const T = 1, Q = 2, M = 3;
    f.g(0); f.g(0); f.op(OP.fne);
    f.ifI32();
    f.i32c(0);
    f.else_();
    f.g(0); f.op(OP.ftrunc); f.s(T);
    f.g(T); f.f64c(4294967296); f.op(OP.fdiv); f.op(OP.ffloor); f.s(Q);
    f.g(T); f.g(Q); f.f64c(4294967296); f.op(OP.fmul); f.op(OP.fsub); f.s(M);
    f.g(M); f.f64c(2147483648); f.op(OP.fge);
    f.ifVoid();
    f.g(M); f.f64c(4294967296); f.op(OP.fsub); f.s(M);
    f.end();
    f.g(M); f.op(OP.i32truncF64s);
    f.end();
  });
}

// sampleLight(lbP,i32 lw,i32 lh,i32 lu,f64 lv,f64) -> f64 — sampleLightBlock.
function emitSample(): number[] {
  return makeFunc(6, 6, (f) => {
    const TXR = 5, TYR = 6, AX0 = 7, AY0 = 8, AX1 = 9, AY1 = 10;
    const FX = 11, FY = 12, A = 13, B = 14, C = 15, D = 16;
    const clampPair = (raw: number, lo: number): void => {
      // lo = clamped copy of raw (matches `x0 = lu|0; if (x0<0) x0=0`)
      f.g(raw); f.s(lo);
      f.g(lo); f.i32c(0); f.op(OP.ilts); f.ifVoid(); f.i32c(0); f.s(lo); f.end();
    };
    f.g(3); f.call(0); f.s(TXR);
    f.g(4); f.call(0); f.s(TYR);
    clampPair(TXR, AX0);
    clampPair(TYR, AY0);
    // x1 = min(x0+1, lw-1), y1 likewise; then clamp x0/y0 to lw-1/lh-1
    f.g(AX0); f.i32c(1); f.op(OP.iadd); f.s(AX1);
    f.g(AY0); f.i32c(1); f.op(OP.iadd); f.s(AY1);
    f.g(AX1); f.g(1); f.i32c(1); f.op(OP.isub); f.op(OP.igts);
    f.ifVoid(); f.g(1); f.i32c(1); f.op(OP.isub); f.s(AX1); f.end();
    f.g(AY1); f.g(2); f.i32c(1); f.op(OP.isub); f.op(OP.igts);
    f.ifVoid(); f.g(2); f.i32c(1); f.op(OP.isub); f.s(AY1); f.end();
    f.g(AX0); f.g(1); f.i32c(1); f.op(OP.isub); f.op(OP.igts);
    f.ifVoid(); f.g(1); f.i32c(1); f.op(OP.isub); f.s(AX0); f.end();
    f.g(AY0); f.g(2); f.i32c(1); f.op(OP.isub); f.op(OP.igts);
    f.ifVoid(); f.g(2); f.i32c(1); f.op(OP.isub); f.s(AY0); f.end();
    // fx = clamp(lu - f64(txr), 0, 1); fy likewise
    f.g(3); f.g(TXR); f.op(OP.f64fromI32s); f.op(OP.fsub); f.s(FX);
    f.g(FX); f.f64c(0); f.op(OP.flt); f.ifVoid(); f.f64c(0); f.s(FX); f.end();
    f.g(FX); f.f64c(1); f.op(OP.fgt); f.ifVoid(); f.f64c(1); f.s(FX); f.end();
    f.g(4); f.g(TYR); f.op(OP.f64fromI32s); f.op(OP.fsub); f.s(FY);
    f.g(FY); f.f64c(0); f.op(OP.flt); f.ifVoid(); f.f64c(0); f.s(FY); f.end();
    f.g(FY); f.f64c(1); f.op(OP.fgt); f.ifVoid(); f.f64c(1); f.s(FY); f.end();
    // a,b,c,d as f64 of the four luxel bytes
    const lux = (yy: number, xx: number, dst: number): void => {
      f.g(0); f.g(yy); f.g(1); f.op(OP.imul); f.g(xx); f.op(OP.iadd);
      f.op(OP.iadd); f.ld8(0); f.op(OP.f64fromI32u); f.s(dst);
    };
    lux(AY0, AX0, A); lux(AY0, AX1, B); lux(AY1, AX0, C); lux(AY1, AX1, D);
    // a + (b-a)*fx + (c-a)*fy + (a-b-c+d)*fx*fy
    f.g(A); f.g(B); f.g(A); f.op(OP.fsub); f.g(FX); f.op(OP.fmul); f.op(OP.fadd);
    f.g(C); f.g(A); f.op(OP.fsub); f.g(FY); f.op(OP.fmul); f.op(OP.fadd);
    f.g(A); f.g(B); f.op(OP.fsub); f.g(C); f.op(OP.fsub); f.g(D); f.op(OP.fadd);
    f.g(FX); f.op(OP.fmul); f.g(FY); f.op(OP.fmul); f.op(OP.fadd);
  });
}

// draw_opaque(16x i32) — the drawSpansSoftware batch loop + runSubdiv16 chain.
function emitDraw(): number[] {
  // params
  const IDXP = 0, ZBP = 1, FBW = 2, FBH = 3, TEXP = 4, WSHIFT = 5, WMASK = 6,
    HMASK = 7, CMAPP = 8, LIGHTP = 9, LIGHTW = 10, LIGHTH = 11,
    SPANSF = 12, SPANSI = 13, N = 14, OUTP = 15;
  // i32 locals
  const SI = 16, Y = 17, X0 = 18, X1 = 19, CX0 = 20, CX1 = 21, COUNT = 22,
    SKIP = 23, O = 24, REM = 25, NN = 26, I = 27, OO = 28, TU = 29, TV = 30,
    DTU = 31, DTV = 32, TXI = 33, GRADE = 34, DRAWN = 35, PIXELS = 36;
  // f64 locals
  const IZ = 37, DIZ = 38, UZ = 39, DUZ = 40, VZ = 41, DVZ = 42, LZ = 43,
    DLZ = 44, U0 = 45, V0 = 46, U1 = 47, V1 = 48, Z1 = 49, L0 = 50, L1 = 51,
    FSKIP = 52, NNF = 53, TA = 54, LU = 55, LV = 56, DLU = 57;
  return makeFunc(21, 21, (f) => {
    // span base address helpers (address left on stack)
    const addrI = (): void => { f.g(SPANSI); f.g(SI); f.i32c(12); f.op(OP.imul); f.op(OP.iadd); };
    const addrF = (): void => { f.g(SPANSF); f.g(SI); f.i32c(88); f.op(OP.imul); f.op(OP.iadd); };
    f.i32c(0); f.s(DRAWN); f.i32c(0); f.s(PIXELS); f.i32c(0); f.s(SI);
    f.block('done');
    f.loop('span');
    f.g(SI); f.g(N); f.op(OP.igeu); f.brIf('done');
    addrI(); f.ld32(0); f.s(Y);
    addrI(); f.ld32(4); f.s(X0);
    addrI(); f.ld32(8); f.s(X1);
    f.block('next');
    // clip y + x
    f.g(Y); f.i32c(0); f.op(OP.ilts); f.brIf('next');
    f.g(Y); f.g(FBH); f.op(OP.iges); f.brIf('next');
    f.g(X0); f.s(CX0);
    f.g(X0); f.i32c(0); f.op(OP.ilts);
    f.ifVoid(); f.i32c(0); f.s(CX0); f.end();
    f.g(X1); f.s(CX1);
    f.g(X1); f.g(FBW); f.op(OP.igts);
    f.ifVoid(); f.g(FBW); f.s(CX1); f.end();
    f.g(CX1); f.g(CX0); f.op(OP.isub); f.s(COUNT);
    f.g(COUNT); f.i32c(0); f.op(OP.iles); f.brIf('next');
    // span gradients
    const fld = (off: number, dst: number): void => { addrF(); f.f64ld(off); f.s(dst); };
    fld(0, IZ); fld(8, DIZ); fld(16, UZ); fld(24, DUZ); fld(32, VZ);
    fld(40, DVZ); fld(48, LZ); fld(56, DLZ); fld(64, LU); fld(72, LV); fld(80, DLU);
    // light gradient (sampleLightBlock per-span setup)
    f.g(LV); f.f64c(0); f.op(OP.fge);
    f.ifVoid();
    f.g(LIGHTP); f.g(LIGHTW); f.g(LIGHTH); f.g(LU); f.g(LV); f.call(1); f.s(L0);
    f.g(LU); f.g(DLU); f.g(COUNT); f.op(OP.f64fromI32s); f.op(OP.fmul);
    f.op(OP.fadd); f.s(TA);
    f.g(LIGHTP); f.g(LIGHTW); f.g(LIGHTH); f.g(TA); f.g(LV); f.call(1); f.s(L1);
    f.g(L0); f.s(LZ);
    f.g(L1); f.g(L0); f.op(OP.fsub); f.g(COUNT); f.op(OP.f64fromI32s);
    f.op(OP.fdiv); f.s(DLZ);
    f.end();
    // clip-adjusted start
    f.g(CX0); f.g(X0); f.op(OP.isub); f.s(SKIP);
    f.g(SKIP); f.op(OP.f64fromI32s); f.s(FSKIP);
    f.g(IZ); f.g(DIZ); f.g(FSKIP); f.op(OP.fmul); f.op(OP.fadd); f.s(IZ);
    f.g(UZ); f.g(DUZ); f.g(FSKIP); f.op(OP.fmul); f.op(OP.fadd); f.s(UZ);
    f.g(VZ); f.g(DVZ); f.g(FSKIP); f.op(OP.fmul); f.op(OP.fadd); f.s(VZ);
    f.g(UZ); f.g(IZ); f.op(OP.fdiv); f.s(U0);
    f.g(VZ); f.g(IZ); f.op(OP.fdiv); f.s(V0);
    f.g(Y); f.g(FBW); f.op(OP.imul); f.g(CX0); f.op(OP.iadd); f.s(O);
    f.g(COUNT); f.s(REM);
    // subdivision chain (mirrors the while(remaining>0) loop)
    f.block('subdone');
    f.loop('sub');
    f.g(REM); f.i32c(0); f.op(OP.iles); f.brIf('subdone');
    f.g(REM); f.i32c(16); f.op(OP.iges);
    f.ifI32(); f.i32c(16); f.else_(); f.g(REM); f.end(); f.s(NN);
    f.g(NN); f.op(OP.f64fromI32s); f.s(NNF);
    // z1,u1,v1 — ONE division per subdivision
    f.f64c(1); f.g(IZ); f.g(DIZ); f.g(NNF); f.op(OP.fmul); f.op(OP.fadd);
    f.op(OP.fdiv); f.s(Z1);
    f.g(UZ); f.g(DUZ); f.g(NNF); f.op(OP.fmul); f.op(OP.fadd);
    f.g(Z1); f.op(OP.fmul); f.s(U1);
    f.g(VZ); f.g(DVZ); f.g(NNF); f.op(OP.fmul); f.op(OP.fadd);
    f.g(Z1); f.op(OP.fmul); f.s(V1);
    // fixed-point stepping (16.16)
    f.g(U0); f.f64c(65536); f.op(OP.fmul); f.call(0); f.s(TU);
    f.g(V0); f.f64c(65536); f.op(OP.fmul); f.call(0); f.s(TV);
    f.g(U1); f.g(U0); f.op(OP.fsub); f.g(NNF); f.op(OP.fdiv);
    f.f64c(65536); f.op(OP.fmul); f.call(0); f.s(DTU);
    f.g(V1); f.g(V0); f.op(OP.fsub); f.g(NNF); f.op(OP.fdiv);
    f.f64c(65536); f.op(OP.fmul); f.call(0); f.s(DTV);
    f.i32c(0); f.s(I); f.g(O); f.s(OO);
    // pixel loop
    f.block('pixdone');
    f.loop('pix');
    f.g(I); f.g(NN); f.op(OP.iges); f.brIf('pixdone');
    // if (iz > zb[oo])
    f.g(IZ);
    f.g(ZBP); f.g(OO); f.i32c(4); f.op(OP.imul); f.op(OP.iadd);
    f.f32ld(0); f.op(OP.f64fromF32);
    f.op(OP.fgt);
    f.ifVoid();
    // zb[oo] = iz (demote f64->f32 exactly like a Float32Array store)
    f.g(ZBP); f.g(OO); f.i32c(4); f.op(OP.imul); f.op(OP.iadd);
    f.g(IZ); f.op(OP.f32demote); f.f32st(0);
    // txi = ((tu>>16)&wmask) + (((tv>>16)&hmask)<<wshift)
    f.g(TU); f.i32c(16); f.op(OP.sshr); f.g(WMASK); f.op(OP.iand);
    f.g(TV); f.i32c(16); f.op(OP.sshr); f.g(HMASK); f.op(OP.iand);
    f.g(WSHIFT); f.op(OP.ishl);
    f.op(OP.iadd); f.s(TXI);
    // grade = toI32(lz)<<8 — a single trunc: trapping is impossible here.
    // lv<0 spans are range-guarded in tryWasmOpaque (light stays in
    // (-1, 64)); lv>=0 spans interpolate two in-range luxel samples, so
    // float rounding can at most touch 63+1ulp / -1ulp, both truncating
    // exactly like the TS `light << 8`.
    f.g(LZ); f.op(OP.i32truncF64s); f.i32c(8); f.op(OP.ishl); f.s(GRADE);
    // idx[oo] = colormap[grade + texels[txi]]
    f.g(IDXP); f.g(OO); f.op(OP.iadd);
    f.g(CMAPP); f.g(GRADE); f.g(TEXP); f.g(TXI); f.op(OP.iadd); f.ld8(0);
    f.op(OP.iadd); f.op(OP.iadd); f.ld8(0);
    f.st8(0);
    f.end(); // endif iz>zb
    f.g(TU); f.g(DTU); f.op(OP.iadd); f.s(TU);
    f.g(TV); f.g(DTV); f.op(OP.iadd); f.s(TV);
    f.g(IZ); f.g(DIZ); f.op(OP.fadd); f.s(IZ);
    f.g(LZ); f.g(DLZ); f.op(OP.fadd); f.s(LZ);
    f.g(I); f.i32c(1); f.op(OP.iadd); f.s(I);
    f.g(OO); f.i32c(1); f.op(OP.iadd); f.s(OO);
    f.br('pix');
    f.end(); f.end(); // pix loop + pixdone block
    // chain to the next subdivision (C snext semantics)
    f.g(UZ); f.g(DUZ); f.g(NNF); f.op(OP.fmul); f.op(OP.fadd); f.s(UZ);
    f.g(VZ); f.g(DVZ); f.g(NNF); f.op(OP.fmul); f.op(OP.fadd); f.s(VZ);
    f.g(U1); f.s(U0); f.g(V1); f.s(V0);
    f.g(O); f.g(NN); f.op(OP.iadd); f.s(O);
    f.g(REM); f.g(NN); f.op(OP.isub); f.s(REM);
    f.br('sub');
    f.end(); f.end(); // sub loop + subdone block
    f.g(PIXELS); f.g(COUNT); f.op(OP.iadd); f.s(PIXELS);
    f.g(DRAWN); f.i32c(1); f.op(OP.iadd); f.s(DRAWN);
    f.end(); // next
    f.g(SI); f.i32c(1); f.op(OP.iadd); f.s(SI);
    f.br('span');
    f.end(); f.end(); // span loop + done block
    f.g(OUTP); f.g(PIXELS); f.st32(0);
    f.g(OUTP); f.g(DRAWN); f.st32(4);
  });
}

// ---- §2 module assembly ----------------------------------------------------

function section(id: number, payload: number[]): number[] {
  const out: number[] = [id];
  uleb(out, payload.length);
  return [...out, ...payload];
}

function str(s: string): number[] {
  const out: number[] = [];
  uleb(out, s.length);
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0x7f);
  return out;
}

/** Build the complete `draw_opaque` module. Exported for tests/diagnostics. */
export function buildSpanModuleBytes(): Uint8Array {
  const types: number[] = [];
  uleb(types, 3);
  types.push(0x60); uleb(types, 1); types.push(0x7c); uleb(types, 1); types.push(0x7f); // toI32
  types.push(0x60); uleb(types, 5);
  types.push(0x7f, 0x7f, 0x7f, 0x7c, 0x7c); uleb(types, 1); types.push(0x7c); // sample
  types.push(0x60); uleb(types, 16);
  for (let i = 0; i < 16; i++) types.push(0x7f);
  uleb(types, 0); // draw_opaque: 16xi32 -> ()
  const imports: number[] = [];
  uleb(imports, 1);
  imports.push(...str('env'), ...str('memory'), 0x02, 0x00);
  uleb(imports, 1); // limits: no maximum, min 1 page
  const funcs: number[] = [];
  uleb(funcs, 3); funcs.push(0x00, 0x01, 0x02);
  const exports: number[] = [];
  uleb(exports, 1);
  exports.push(...str('draw_opaque'), 0x00);
  uleb(exports, 2);
  const code: number[] = [];
  uleb(code, 3);
  code.push(...emitToI32(), ...emitSample(), ...emitDraw());
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, types), ...section(2, imports), ...section(3, funcs),
    ...section(7, exports), ...section(10, code),
  ];
  return new Uint8Array(bytes);
}

let cachedModule: WebAssembly.Module | null = null;

function getModule(): WebAssembly.Module {
  if (!cachedModule) cachedModule = new WebAssembly.Module(buildSpanModuleBytes());
  return cachedModule;
}

/** The 16-parameter draw entry point. Mirrors the TS batch signature. */
export type DrawOpaqueFn = (
  idxP: number, zbP: number, fbW: number, fbH: number,
  texP: number, wshift: number, wmask: number, hmask: number,
  cmapP: number, lightP: number, lightW: number, lightH: number,
  spansF: number, spansI: number, n: number, outP: number,
) => void;

export interface WasmMemoryLayout {
  pages: number;
  idxOff: number; zbOff: number; texOff: number; cmapOff: number;
  lightOff: number; spansFOff: number; spansIOff: number; outOff: number;
}

/** Byte layout of the backend's linear memory for a W×H framebuffer. */
export function wasmMemoryLayout(w: number, h: number): WasmMemoryLayout {
  const n = w * h;
  const zbOff = (n + 3) & ~3;
  const texOff = zbOff + n * 4;
  const cmapOff = texOff + TEX_CAP;
  const lightOff = cmapOff + COLORMAP_SIZE;
  const spansFOff = (lightOff + LIGHT_CAP + 7) & ~7;
  const spansIOff = spansFOff + MAX_WASM_SPANS * F_PER_SPAN * 8;
  const outOff = spansIOff + MAX_WASM_SPANS * I_PER_SPAN * 4;
  const total = outOff + 8;
  return { pages: Math.ceil(total / 65536), idxOff: 0, zbOff, texOff, cmapOff, lightOff, spansFOff, spansIOff, outOff };
}

// ---------------------------------------------------------------------------
// §3 WasmSpanBackend — drop-in SoftwareBackend with a wasm opaque-span loop.
// ---------------------------------------------------------------------------

/**
 * WASM spanfill backend (M9.1). Extends SoftwareBackend so every frame.ts
 * call site keeps compiling; only the opaque-span pass moves to wasm.
 * Turbulent spans reuse the TS monomorphic loop. Buffers (idx/zb) live in
 * wasm linear memory; the renderer swaps its views to them on enable.
 */
export class WasmSpanBackend extends SoftwareBackend {
  private readonly mem: WebAssembly.Memory;
  private readonly drawOpaque: DrawOpaqueFn;
  private readonly layout: WasmMemoryLayout;
  private readonly texReg: Uint8Array;
  private readonly cmapReg: Uint8Array;
  private readonly lightReg: Uint8Array;
  private readonly spansF: Float64Array;
  private readonly spansI: Int32Array;
  private readonly out: Int32Array;
  private lastTexels: Uint8Array | null = null;
  private lastLight: Uint8Array | null = null;
  private lastColormap: Uint8Array | null = null;
  /** Observability (BRAIN.md §10.3): batches via wasm vs TS fallback. */
  wasmBatches = 0;
  fallbackBatches = 0;

  private constructor(
    mem: WebAssembly.Memory, drawOpaque: DrawOpaqueFn, layout: WasmMemoryLayout,
    w: number, h: number,
  ) {
    super();
    this.mem = mem;
    this.drawOpaque = drawOpaque;
    this.layout = layout;
    const buf = mem.buffer;
    const n = w * h;
    this.idx = new Uint8Array(buf, layout.idxOff, n);
    this.zb = new Float32Array(buf, layout.zbOff, n);
    this.fbW = w;
    this.fbH = h;
    this.texReg = new Uint8Array(buf, layout.texOff, TEX_CAP);
    this.cmapReg = new Uint8Array(buf, layout.cmapOff, COLORMAP_SIZE);
    this.lightReg = new Uint8Array(buf, layout.lightOff, LIGHT_CAP);
    this.spansF = new Float64Array(buf, layout.spansFOff, MAX_WASM_SPANS * F_PER_SPAN);
    this.spansI = new Int32Array(buf, layout.spansIOff, MAX_WASM_SPANS * I_PER_SPAN);
    this.out = new Int32Array(buf, layout.outOff, 2);
  }

  /**
   * Create a backend for a W×H framebuffer, or null when wasm is
   * unavailable (or the frame is absurdly large). Never throws.
   */
  static create(w: number, h: number): WasmSpanBackend | null {
    try {
      if (!(w > 0 && h > 0 && w <= 4096 && h <= 4096)) return null;
      const layout = wasmMemoryLayout(w, h);
      if (!Number.isFinite(layout.pages) || layout.pages > 4096) return null;
      const mem = new WebAssembly.Memory({ initial: layout.pages });
      const inst = new WebAssembly.Instance(getModule(), { env: { memory: mem } });
      const fn = inst.exports['draw_opaque'];
      if (typeof fn !== 'function') return null;
      return new WasmSpanBackend(mem, fn as DrawOpaqueFn, layout, w, h);
    } catch {
      return null;
    }
  }

  /**
   * Bind shared state. The idx/zb arguments are accepted for
   * SoftwareBackend compatibility but the backend always draws into its
   * own wasm-memory views (exposed as `idx`/`zb`); the renderer swaps to
   * those views when this backend is active.
   */
  override attach(
    _idx: Uint8Array, _zb: Float32Array, w: number, h: number, colormap: Uint8Array,
  ): void {
    if (w !== this.fbW || h !== this.fbH) {
      Com_Error('drop', `WasmSpanBackend: attach ${w}x${h} != memory ${this.fbW}x${this.fbH}`);
    }
    this.colormap = colormap;
  }

  override drawSpans(list: SpanList, tex: Texture, light: LightBlock): void {
    if (!this.tryWasmOpaque(list, tex, light)) {
      this.fallbackBatches++;
      // Fallback IS the reference: identical output, TS speed.
      const a = drawSpansSoftware(
        this.idx, this.zb, this.fbW, this.fbH, list, tex, light, this.colormap,
      );
      this.spansDrawn += a.spans;
      this.pixelsDrawn += a.pixels;
    }
    const b = drawSpansTurbulent(
      this.idx, this.zb, this.fbW, this.fbH, list, tex,
      this.colormap, this.turbTable, this.time,
    );
    this.spansDrawn += b.spans;
    this.pixelsDrawn += b.pixels;
    // Flat spans (sky) stay in TS like turbulent ones: per-span color,
    // same reference loop as SoftwareBackend, so wasm output is identical.
    const c = drawSpansFlatPerSpan(
      this.idx, this.zb, this.fbW, this.fbH, list,
    );
    this.spansDrawn += c.spans;
    this.pixelsDrawn += c.pixels;
  }

  /**
   * Run the opaque spans of a batch through wasm. Returns false when the
   * batch is outside the fast path (caller runs the TS reference instead).
   */
  private tryWasmOpaque(list: SpanList, tex: Texture, light: LightBlock): boolean {
    const spans = list.spans;
    const total = list.count < spans.length ? list.count : spans.length;
    // Count opaque spans + estimate batch pixels in one pass. Tiny batches
    // stay on the TS path (transition + packing > per-pixel win); the
    // estimate rides here so small batches skip staging/packing entirely.
    let n = 0;
    let est = 0;
    for (let i = 0; i < total; i++) {
      const s = spans[i]!;
      if (s.kind !== SPAN_OPAQUE) continue;
      n++;
      est += s.x1 - s.x0;
    }
    if (n === 0) return true;
    if (n > MAX_WASM_SPANS) return false;
    if (est < MIN_WASM_PIXELS) return false;
    const tw = tex.width | 0, th = tex.height | 0;
    const lw = light.width | 0, lh = light.height | 0;
    if (!(tw > 0 && th > 0 && lw > 0 && lh > 0)) return false;
    if (tex.texels.length < tw * th || tex.texels.length > TEX_CAP) return false;
    if (light.values.length < lw * lh || light.values.length > LIGHT_CAP) return false;
    if (this.colormap.length < COLORMAP_SIZE) return false;
    // Power-of-two textures only: for other widths the masked stride can
    // address past the texel block (the TS reference reads `undefined`
    // there and writes index 0). The fallback preserves that exactly.
    if ((tw & (tw - 1)) !== 0 || (th & (th - 1)) !== 0) return false;
    // Stage surface data; skip copies when the backing store is unchanged
    // (surface blocks are cache-owned, so steady state copies ~nothing).
    if (this.lastTexels !== tex.texels) {
      this.texReg.set(tex.texels);
      this.lastTexels = tex.texels;
    }
    if (this.lastLight !== light.values) {
      this.lightReg.set(light.values);
      this.lastLight = light.values;
    }
    if (this.lastColormap !== this.colormap) {
      this.cmapReg.set(this.colormap.subarray(0, COLORMAP_SIZE));
      this.lastColormap = this.colormap;
    }
    // Pack spans (flat typed arrays, zero allocation). The light-range
    // guard rides along in the same pass.
    const F = this.spansF, I = this.spansI;
    let p = 0;
    for (let i = 0; i < total; i++) {
      const s = spans[i]!;
      if (s.kind !== SPAN_OPAQUE) continue;
      if (s.lv < 0) {
        // Colormap grades must stay in 0..63 (64+ reads past the 16K table;
        // the engine always produces 0..63, lv>=0 spans interpolate in-range
        // samples). Verify the linear light ramp stays inside (-1, 64).
        const lo = s.light, hi = s.light + s.dlight * (s.x1 - s.x0);
        if (!(lo > -1 && lo < 64 && hi > -1 && hi < 64)) return false;
      }
      const o = p * F_PER_SPAN;
      F[o] = s.iz; F[o + 1] = s.diz; F[o + 2] = s.uz; F[o + 3] = s.duz;
      F[o + 4] = s.vz; F[o + 5] = s.dvz; F[o + 6] = s.light;
      F[o + 7] = s.dlight; F[o + 8] = s.lu; F[o + 9] = s.lv; F[o + 10] = s.dlu;
      const q = p * I_PER_SPAN;
      I[q] = s.y; I[q + 1] = s.x0; I[q + 2] = s.x1;
      p++;
    }
    const { wshift, wmask, hmask } = textureMasks(tex);
    const L = this.layout;
    this.drawOpaque(
      L.idxOff, L.zbOff, this.fbW, this.fbH,
      L.texOff, wshift, wmask, hmask,
      L.cmapOff, L.lightOff, lw, lh,
      L.spansFOff, L.spansIOff, n, L.outOff,
    );
    this.wasmBatches++;
    this.pixelsDrawn += this.out[0]!;
    this.spansDrawn += this.out[1]!;
    return true;
  }
}
