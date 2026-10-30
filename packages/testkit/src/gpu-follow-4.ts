// @q2/testkit — GPU-FOLLOW-4 lane helpers (lifecycle, switching, resize, loss).
//
// Hermetic + DOM-free (Node-safe, browser-safe): every helper below is a pure
// structural harness over the PUBLIC backend API (`WebGLRenderer` test hooks)
// and production-glue mirrors BY VALUE. Ownership is explicit:
//
// - Asset migration is NOT reimplemented here: cycle tests replay retained
//   assets through `replayRetainedAssetsMirror` from `./gpu-follow-2a.js`
//   (FOLLOW-2A shape, reused BY NAME). `replayViolations` below only checks
//   its outcome.
// - Resource accounting (`testLiveResources` / `testDeleteCounts`) is owned
//   by `@q2/webgl-renderer`; `snapshotGpuLifecycle` only reads it.
// - Canvas reuse-by-id + stacking mirrors `acquireGpuCanvas` /
//   `removeGpuCanvas` in `apps/web/src/gpu-canvas.ts` BY VALUE; the
//   contextlost/restored listener discipline mirrors the FOLLOW-4 target
//   contract (preventDefault where restoration is supported, stop submission
//   on loss, re-create after restore). Browser glue owns the real wiring.
// - Selection fallback vocabulary mirrors `resolveRendererSelection` in
//   `@q2/renderer-api` and `describeRendererSelection` in `@q2/config`
//   BY VALUE; `switchViolations` only checks the recorded outcome.
//
// No `any` in exported signatures. Pure validators return violation lists
// (empty = clean); tests fail loudly on any entry.

import type { WebGLRenderer } from '@q2/webgl-renderer';
import type { ReplayOutcome } from './gpu-follow-2a.js';

// --- Lifecycle snapshots (reads webgl-renderer hooks by name) ----------------

/** Live owned GL objects (webgl-renderer `testLiveResources` shape, by value). */
export interface Follow4LiveResources {
  textures: number;
  buffers: number;
  framebuffers: number;
  renderbuffers: number;
  programs: number;
}

/** Cumulative same-context deletes (webgl-renderer `testDeleteCounts` shape). */
export interface Follow4DeleteCounts {
  textures: number;
  buffers: number;
  framebuffers: number;
  renderbuffers: number;
  programs: number;
}

/** One lifecycle observation: resource counts + submission + surface state. */
export interface Follow4LifecycleSnapshot {
  live: Follow4LiveResources;
  deletes: Follow4DeleteCounts;
  uploads: number;
  modelCache: number;
  warnings: number;
  framesSubmitted: number;
  target: { w: number; h: number; float: boolean } | null;
  width: number;
  height: number;
  contextLost: boolean;
  lastError: string | null;
  models: number[];
  skins: number[];
}

/** Read every FOLLOW-4 lifecycle hook in one snapshot (no rendering). */
export function snapshotGpuLifecycle(r: WebGLRenderer): Follow4LifecycleSnapshot {
  const s = r.getStatus();
  return {
    live: { ...r.testLiveResources() },
    deletes: { ...r.testDeleteCounts() },
    uploads: r.testUploadStats().uploads,
    modelCache: r.testModelCacheSize(),
    warnings: r.testWarnings().length,
    framesSubmitted: s.framesSubmitted,
    target: r.testTargetInfo() ? { ...r.testTargetInfo()! } : null,
    width: s.width,
    height: s.height,
    contextLost: s.contextLost,
    lastError: s.lastError,
    models: r.testRegisteredModels(),
    skins: r.testRegisteredSkins(),
  };
}

/** Per-cycle expectations for `lifecycleViolations` (exact pins, no ranges). */
export interface Follow4CycleExpect {
  /** Expected upload-count growth (0 normally; 1 per map generation bump). */
  uploadDelta: number;
  /** Minimum framesSubmitted growth (0 while loss stops submission). */
  framesAdvanceAtLeast: number;
  /** Required size after the cycle (null = must equal the before size). */
  size: { width: number; height: number } | null;
  /** Required loss flag after the cycle (null = must equal the before flag). */
  lost: boolean | null;
  /**
   * Required lastError substring after the cycle (null = lastError must be
   * null). Loss legs pass 'context lost'; every render leg passes null.
   */
  errorSubstring: string | null;
}

/**
 * Compare two lifecycle snapshots against exact expectations. Live resource
 * counts, model cache, warning count and registry handles must be IDENTICAL
 * across every repeated cycle (no accumulation, no duplicates, no drift);
 * only uploads/frames/size/loss/error may move, and only as declared.
 */
export function lifecycleViolations(
  before: Follow4LifecycleSnapshot,
  after: Follow4LifecycleSnapshot,
  expect: Follow4CycleExpect,
): string[] {
  const out: string[] = [];
  if (after.uploads - before.uploads !== expect.uploadDelta) {
    out.push(`uploads moved ${before.uploads} -> ${after.uploads} (expected delta ${expect.uploadDelta})`);
  }
  if (after.framesSubmitted - before.framesSubmitted < expect.framesAdvanceAtLeast) {
    out.push(
      `framesSubmitted moved ${before.framesSubmitted} -> ${after.framesSubmitted} ` +
      `(expected advance >= ${expect.framesAdvanceAtLeast})`,
    );
  }
  const wantSize = expect.size ?? { width: before.width, height: before.height };
  if (after.width !== wantSize.width || after.height !== wantSize.height) {
    out.push(`size is ${after.width}x${after.height} (expected ${wantSize.width}x${wantSize.height})`);
  }
  if (expect.size) {
    if (!after.target || after.target.w !== expect.size.width || after.target.h !== expect.size.height) {
      out.push(
        `render target is ${after.target ? `${after.target.w}x${after.target.h}` : 'null'} ` +
        `(expected ${expect.size.width}x${expect.size.height} after resize+render)`,
      );
    }
  } else if (before.target && after.target) {
    if (after.target.w !== before.target.w || after.target.h !== before.target.h) {
      out.push(`render target moved without resize (${before.target.w}x${before.target.h} -> ${after.target.w}x${after.target.h})`);
    }
  }
  const wantLost = expect.lost ?? before.contextLost;
  if (after.contextLost !== wantLost) {
    out.push(`contextLost is ${after.contextLost} (expected ${wantLost})`);
  }
  if (expect.errorSubstring === null) {
    if (after.lastError !== null) out.push(`lastError is ${JSON.stringify(after.lastError)} (expected null)`);
  } else if (after.lastError === null || !after.lastError.includes(expect.errorSubstring)) {
    out.push(`lastError is ${JSON.stringify(after.lastError)} (expected to contain ${JSON.stringify(expect.errorSubstring)})`);
  }
  const liveKeys = ['textures', 'buffers', 'framebuffers', 'renderbuffers', 'programs'] as const;
  for (const k of liveKeys) {
    if (after.live[k] !== before.live[k]) {
      out.push(`live ${k} moved ${before.live[k]} -> ${after.live[k]} (repeated cycles must hold counts stable)`);
    }
  }
  if (after.modelCache !== before.modelCache) {
    out.push(`modelCache moved ${before.modelCache} -> ${after.modelCache} (replay must not duplicate GL entries)`);
  }
  if (after.warnings !== before.warnings) {
    out.push(`warnings moved ${before.warnings} -> ${after.warnings} (stable cycles add no warnings)`);
  }
  if (JSON.stringify(after.models) !== JSON.stringify(before.models)) {
    out.push(`model registry drifted ${JSON.stringify(before.models)} -> ${JSON.stringify(after.models)}`);
  }
  if (JSON.stringify(after.skins) !== JSON.stringify(before.skins)) {
    out.push(`skin registry drifted ${JSON.stringify(before.skins)} -> ${JSON.stringify(after.skins)}`);
  }
  return out;
}

// --- Retained-asset replay outcome (FOLLOW-2A shape, reused by name) ---------

/**
 * Check a `replayRetainedAssetsMirror` outcome (FOLLOW-2A shape BY NAME):
 * zero failures, exact model/skin counts. One bad lump must fail the cycle,
 * never pass silently on a half-mirrored roster.
 */
export function replayViolations(outcome: ReplayOutcome, expectedModels: number, expectedSkins: number): string[] {
  const out: string[] = [];
  for (const f of outcome.failures) out.push(`replay failure: ${f}`);
  if (outcome.models !== expectedModels) {
    out.push(`replayed models=${outcome.models} (expected ${expectedModels})`);
  }
  if (outcome.skins !== expectedSkins) {
    out.push(`replayed skins=${outcome.skins} (expected ${expectedSkins})`);
  }
  return out;
}

// --- Canvas/listener mirror (production glue BY VALUE) -----------------------
//
// Mirrors `acquireGpuCanvas` / `removeGpuCanvas` in apps/web/src/gpu-canvas.ts:
// reuse-by-id (`q2-gl`), single live canvas, attach/detach of the
// contextlost/restored listeners. The listener DISPATCH contract (prevent
// default where restoration is supported, forward loss/restore to the backend)
// is the FOLLOW-4 target the browser-glue wiring lane must satisfy; this
// mirror pins it hermetically so repeated-cycle tests run without a DOM.

/** Canvas id reused across boots/hot-swaps (by value from GPU_CANVAS_ID). */
export const FOLLOW4_GPU_CANVAS_ID = 'q2-gl';

/** Context event types the glue must forward (by value from the DOM contract). */
export type Follow4EventType = 'webglcontextlost' | 'webglcontextrestored';

/** Minimal context-event shape (preventDefault discipline is the contract). */
export interface Follow4ContextEvent {
  type: Follow4EventType;
  cancelable: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

export type Follow4ContextHandler = (ev: Follow4ContextEvent) => void;

/** Structural fake canvas (no DOM): id reuse + listener accounting. */
export interface Follow4FakeCanvas {
  id: string;
  width: number;
  height: number;
  wired: boolean;
  listenerCount(type: Follow4EventType): number;
  addEventListener(type: string, fn: Follow4ContextHandler): void;
  removeEventListener(type: string, fn: Follow4ContextHandler): void;
  dispatch(type: Follow4EventType): Follow4ContextEvent;
}

/** Create one fake canvas (unattached until the mirror places it by id). */
export function createFollow4FakeCanvas(id: string): Follow4FakeCanvas {
  const handlers = new Map<Follow4EventType, Follow4ContextHandler[]>();
  const canvas: Follow4FakeCanvas = {
    id,
    width: 0,
    height: 0,
    wired: false,
    listenerCount(type: Follow4EventType): number {
      return handlers.get(type)?.length ?? 0;
    },
    addEventListener(type: string, fn: Follow4ContextHandler): void {
      if (type !== 'webglcontextlost' && type !== 'webglcontextrestored') return;
      const list = handlers.get(type) ?? [];
      if (!list.includes(fn)) list.push(fn);
      handlers.set(type, list);
    },
    removeEventListener(type: string, fn: Follow4ContextHandler): void {
      if (type !== 'webglcontextlost' && type !== 'webglcontextrestored') return;
      const list = handlers.get(type) ?? [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    dispatch(type: Follow4EventType): Follow4ContextEvent {
      let prevented = false;
      const ev: Follow4ContextEvent = {
        type,
        cancelable: true,
        get defaultPrevented(): boolean {
          return prevented;
        },
        preventDefault(): void {
          prevented = true;
        },
      };
      for (const fn of [...(handlers.get(type) ?? [])]) fn(ev);
      return ev;
    },
  };
  return canvas;
}

/** Structural fake document: canvas factory + by-id lookup (no DOM). */
export interface Follow4FakeDoc {
  /** Total canvases ever created (repeated acquire-without-remove must not grow this). */
  created: number;
  /** Live canvases under the GPU id (never more than 1). */
  live: number;
  byId(id: string): Follow4FakeCanvas | null;
  createElement(tag: string): Follow4FakeCanvas | null;
  /** Place a created canvas under its id (mirrors DOM insertion). */
  place(el: Follow4FakeCanvas): void;
  remove(id: string): boolean;
}

/** Create a fake document backing the canvas-glue mirror. */
export function createFollow4FakeDoc(): Follow4FakeDoc {
  const canvases = new Map<string, Follow4FakeCanvas>();
  let created = 0;
  return {
    get created(): number {
      return created;
    },
    get live(): number {
      return canvases.size;
    },
    byId(id: string): Follow4FakeCanvas | null {
      return canvases.get(id) ?? null;
    },
    createElement(tag: string): Follow4FakeCanvas | null {
      if (tag !== 'canvas') return null;
      created++;
      return createFollow4FakeCanvas('');
    },
    place(el: Follow4FakeCanvas): void {
      canvases.set(el.id, el);
    },
    remove(id: string): boolean {
      return canvases.delete(id);
    },
  };
}

/** Backend hooks the glue forwards context events to (test spy surface). */
export interface Follow4CanvasHooks {
  onLost(): void;
  onRestored(): void;
}

/** Wiring bundle: backend hooks + attached listener identities (for detach). */
export interface Follow4CanvasWiring extends Follow4CanvasHooks {
  lostHandler?: Follow4ContextHandler;
  restoredHandler?: Follow4ContextHandler;
}

/**
 * Mirror of `acquireGpuCanvas` BY VALUE: reuse the canvas by id when live
 * (never a duplicate), otherwise create + size + wire the two context
 * listeners EXACTLY once (idempotent: re-acquire never double-attaches).
 * The wired wrappers preventDefault (restoration supported) then forward to
 * the backend hooks — the FOLLOW-4 target contract for the wiring lane.
 */
export function acquireMirrorGpuCanvas(
  doc: Follow4FakeDoc,
  width: number,
  height: number,
  hooks: Follow4CanvasWiring,
): Follow4FakeCanvas {
  const found = doc.byId(FOLLOW4_GPU_CANVAS_ID);
  if (found) {
    if (width > 0) found.width = width;
    if (height > 0) found.height = height;
    return found;
  }
  const el = doc.createElement('canvas');
  if (!el) throw new Error('follow-4 mirror: fake document cannot create a canvas');
  el.id = FOLLOW4_GPU_CANVAS_ID;
  if (width > 0) el.width = width;
  if (height > 0) el.height = height;
  if (!el.wired) {
    const onLost: Follow4ContextHandler = (ev) => {
      ev.preventDefault();
      hooks.onLost();
    };
    const onRestored: Follow4ContextHandler = (ev) => {
      ev.preventDefault();
      hooks.onRestored();
    };
    hooks.lostHandler = onLost;
    hooks.restoredHandler = onRestored;
    el.addEventListener('webglcontextlost', onLost);
    el.addEventListener('webglcontextrestored', onRestored);
    el.wired = true;
  }
  doc.place(el);
  return el;
}

/**
 * Mirror of `removeGpuCanvas` BY VALUE: detach the two context listeners
 * (balanced: counts return to zero) and remove the canvas by id. Returns
 * false when no GL canvas is live (headless-safe, never throws).
 */
export function removeMirrorGpuCanvas(doc: Follow4FakeDoc, hooks: Follow4CanvasWiring): boolean {
  const el = doc.byId(FOLLOW4_GPU_CANVAS_ID);
  if (!el) return false;
  if (hooks.lostHandler) el.removeEventListener('webglcontextlost', hooks.lostHandler);
  if (hooks.restoredHandler) el.removeEventListener('webglcontextrestored', hooks.restoredHandler);
  return doc.remove(FOLLOW4_GPU_CANVAS_ID);
}

/**
 * Canvas-glue invariants across repeated acquire/remove cycles: at most one
 * live canvas, exact live count, and exactly one attached listener per
 * context event type on every live canvas (no duplicates, no leaks).
 */
export function canvasGlueViolations(doc: Follow4FakeDoc, expectLive: number): string[] {
  const out: string[] = [];
  if (doc.live !== expectLive) {
    out.push(`live canvases=${doc.live} (expected ${expectLive})`);
  }
  if (doc.live > 1) {
    out.push(`duplicate canvases: ${doc.live} live under one document (reuse-by-id broken)`);
  }
  const el = doc.byId(FOLLOW4_GPU_CANVAS_ID);
  if (expectLive > 0) {
    if (!el) {
      out.push('expected a live canvas under q2-gl, found none');
    } else {
      for (const t of ['webglcontextlost', 'webglcontextrestored'] as const) {
        const n = el.listenerCount(t);
        if (n !== 1) out.push(`canvas ${t} listeners=${n} (expected exactly 1: no duplicates, no leaks)`);
      }
    }
  }
  return out;
}

// --- Renderer switching + fallback-masquerade gate ---------------------------
//
// Vocabulary mirrors `resolveRendererSelection` (@q2/renderer-api) and
// `describeRendererSelection` (@q2/config) BY VALUE. The gate is absolute:
// a leg that ran on the CPU fallback (active software + warning) must NEVER
// be reported as GPU execution, however healthy its frames look.

/** One recorded renderer leg: request, outcome, and submission evidence. */
export interface Follow4SwitchRecord {
  /** Leg label (e.g. 'gpu-cycle-2', 'unsupported-device-fallback'). */
  label: string;
  /** `vid_renderer` request as written. */
  requested: string;
  /** Backend that actually ran. */
  active: string;
  /** Fallback warning (null when the request was honored). */
  warning: string | null;
  framesStart: number;
  framesEnd: number;
  /** True only when this leg claims to be GPU execution. */
  claimsGpuExecution: boolean;
}

/**
 * Genuine-GPU gate: a leg claiming GPU execution must run on
 * `webgl2-experimental` with NO fallback warning and advancing frames. A
 * fallback leg (software + warning) claiming GPU execution is the
 * masquerade this card forbids. Non-claiming legs only need monotonic
 * frames (evidence, not execution proof).
 */
export function switchViolations(rec: Follow4SwitchRecord): string[] {
  const out: string[] = [];
  if (rec.framesEnd < rec.framesStart) {
    out.push(`${rec.label}: frames went backwards ${rec.framesStart} -> ${rec.framesEnd}`);
  }
  if (rec.claimsGpuExecution) {
    if (rec.active !== 'webgl2-experimental') {
      out.push(
        `${rec.label}: claims GPU execution but ran on ${rec.active} ` +
        `(fallback masquerading as GPU execution is forbidden)`,
      );
    }
    if (rec.warning !== null) {
      out.push(`${rec.label}: claims GPU execution but carries fallback warning ${JSON.stringify(rec.warning)}`);
    }
    if (!(rec.framesEnd > rec.framesStart)) {
      out.push(`${rec.label}: claims GPU execution but submitted no frames (${rec.framesStart} -> ${rec.framesEnd})`);
    }
  }
  return out;
}

/** One-line-per-leg switch report (genuine vs fallback, always explicit). */
export function formatSwitchReport(recs: Follow4SwitchRecord[]): string {
  const lines = ['follow-4 renderer switching (fallback is never GPU execution)'];
  for (const r of recs) {
    const bad = switchViolations(r);
    const mark = bad.length === 0 ? 'ok' : `VIOLATION: ${bad.join('; ')}`;
    const fb = r.warning === null ? 'honored' : `fallback (${r.warning})`;
    lines.push(
      `  ${r.label}: requested=${JSON.stringify(r.requested)} active=${r.active} ${fb} ` +
      `frames ${r.framesStart} -> ${r.framesEnd}${r.claimsGpuExecution ? ' [claims GPU]' : ''} :: ${mark}`,
    );
  }
  return lines.join('\n');
}

// --- Real browser context-loss mechanism (WEBGL_lose_context) ----------------
//
// The loss/restore legs below drive the REAL browser mechanism (the
// `WEBGL_lose_context` extension), never a synthetic flag: `loseContext()`
// makes the browser fire a genuine `webglcontextlost` event on the canvas,
// `restoreContext()` the genuine `webglcontextrestored`. Each function
// returns a single-expression IIFE source for CDP evaluate.

/** Extension id of the real browser context-loss mechanism. */
export const CONTEXT_LOSS_EXTENSION = 'WEBGL_lose_context';

/** Recorder slot for context-event counts observed in the page. */
export const FOLLOW4_CTX_RECORDER = '__q2follow4ctx';

/** Install lost/restored counters + preventDefault listeners on a canvas. */
export function installContextEventRecorderScript(canvasId: string): string {
  return `(function(){var c=document.getElementById(${JSON.stringify(canvasId)});if(!c)return false;var w=window;w[${JSON.stringify(FOLLOW4_CTX_RECORDER)}]={lost:0,restored:0};c.addEventListener('webglcontextlost',function(e){try{e.preventDefault();}catch(_){}w[${JSON.stringify(FOLLOW4_CTX_RECORDER)}].lost++;});c.addEventListener('webglcontextrestored',function(e){w[${JSON.stringify(FOLLOW4_CTX_RECORDER)}].restored++;});return true;})()`;
}

/** Create a throwaway probe canvas in the page (mechanism proof surface). */
export function createProbeCanvasScript(canvasId: string, width: number, height: number): string {
  return `(function(){if(document.getElementById(${JSON.stringify(canvasId)}))return true;var c=document.createElement('canvas');c.id=${JSON.stringify(canvasId)};c.width=${width};c.height=${height};try{document.body.appendChild(c);}catch(_){return false;}return !!document.getElementById(${JSON.stringify(canvasId)});})()`;
}

/** Stash slot for live WEBGL_lose_context extension objects, keyed by canvas id. */
export const FOLLOW4_CTX_EXT = '__q2follow4ext';

/** Lose the canvas context through the real extension mechanism. */
export function loseContextScript(canvasId: string): string {
  return `(function(){var c=document.getElementById(${JSON.stringify(canvasId)});if(!c)return{hasCanvas:false,lost:false};var gl=null;try{gl=c.getContext('webgl2');}catch(_){gl=null;}if(!gl)return{hasCanvas:true,lost:false};var ext=null;try{ext=gl.getExtension(${JSON.stringify(CONTEXT_LOSS_EXTENSION)});}catch(_){ext=null;}if(!ext)return{hasCanvas:true,lost:false};try{ext.loseContext();}catch(_){return{hasCanvas:true,lost:false};}try{var w=window;w[${JSON.stringify(FOLLOW4_CTX_EXT)}]=w[${JSON.stringify(FOLLOW4_CTX_EXT)}]||{};w[${JSON.stringify(FOLLOW4_CTX_EXT)}][${JSON.stringify(canvasId)}]=ext;}catch(_){}return{hasCanvas:true,lost:true};})()`;
}

/** Restore the canvas context through the real extension mechanism. */
export function restoreContextScript(canvasId: string): string {
  return `(function(){var c=document.getElementById(${JSON.stringify(canvasId)});if(!c)return{hasCanvas:false,restored:false};var w=window;var ext=null;try{ext=(w[${JSON.stringify(FOLLOW4_CTX_EXT)}]||{})[${JSON.stringify(canvasId)}]||null;}catch(_){ext=null;}if(!ext){var gl=null;try{gl=c.getContext('webgl2');}catch(_){gl=null;}if(!gl)return{hasCanvas:true,restored:false};try{ext=gl.getExtension(${JSON.stringify(CONTEXT_LOSS_EXTENSION)});}catch(_){ext=null;}}if(!ext)return{hasCanvas:true,restored:false};try{ext.restoreContext();}catch(_){return{hasCanvas:true,restored:false};}return{hasCanvas:true,restored:true};})()`;
}

/** Read the installed recorder counters (null when not installed). */
export function readContextEventsScript(): string {
  return `(function(){var r=window[${JSON.stringify(FOLLOW4_CTX_RECORDER)}];return r?{lost:r.lost,restored:r.restored}:null;})()`;
}

/** Remove a throwaway probe canvas from the page. */
export function removeProbeCanvasScript(canvasId: string): string {
  return `(function(){var c=document.getElementById(${JSON.stringify(canvasId)});if(!c)return true;try{c.remove();}catch(_){return false;}return !document.getElementById(${JSON.stringify(canvasId)});})()`;
}

/** Observed browser loss/recovery evidence for one canvas cycle. */
export interface Follow4BrowserLossEvidence {
  canvasId: string;
  mechanism: string;
  lostEvents: number | null;
  restoredEvents: number | null;
  framesBeforeLoss: number | null;
  framesWhileLost: number | null;
  framesAfterRestore: number | null;
  rendererBefore: string | null;
  rendererAfter: string | null;
  warningAfter: string | null;
}

/** Render browser loss/recovery evidence as explicit report lines. */
export function formatBrowserLossEvidence(e: Follow4BrowserLossEvidence): string {
  const stuck = e.framesBeforeLoss !== null && e.framesWhileLost !== null
    ? (e.framesWhileLost === e.framesBeforeLoss ? 'frozen (submission stopped)' : `advanced ${e.framesBeforeLoss} -> ${e.framesWhileLost} WHILE LOST`)
    : 'unobserved';
  const resumed = e.framesWhileLost !== null && e.framesAfterRestore !== null
    ? (e.framesAfterRestore > e.framesWhileLost ? `resumed (${e.framesWhileLost} -> ${e.framesAfterRestore})` : 'DID NOT RESUME')
    : 'unobserved';
  return (
    `follow-4 browser loss/recovery (${e.canvasId} via ${e.mechanism}): ` +
    `lostEvents=${String(e.lostEvents)} restoredEvents=${String(e.restoredEvents)}; ` +
    `while-lost: ${stuck}; after-restore: ${resumed}; ` +
    `renderer ${String(e.rendererBefore)} -> ${String(e.rendererAfter)} ` +
    `warning=${JSON.stringify(e.warningAfter)}`
  );
}
