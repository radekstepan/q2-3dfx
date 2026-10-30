// @q2/testkit — gpu-browser test page builder (PROOF-3 boxes 4-5).
//
// Builds the HTML page the harness serves to real Chromium at runtime (never
// committed). The page imports the BUILT production dists
// (@q2/webgl-renderer, @q2/sw-renderer, @q2/bsp, @q2/formats) through an
// import map, boots the real base1 F0/F1 proof-route scene, compiles the
// production shaders, renders to a real canvas, and publishes
// window.__q2proof with compile/draw/coverage stats plus an rAF timing loop.
//
// DOCUMENTED SEAM: entity placement/light/particle numbers are duplicated BY
// VALUE from packages/testkit/src/bench-workloads.ts (fixedBenchEntities,
// combatBenchEntities, pumpBenchLights, benchSparkParticles), the camera from
// gpuProofViewFor (packages/testkit/src/gpu-proof.ts), and the pinned cvars
// from pinBenchCvars (same file) — mirroring the F1 leg of
// packages/webgl-renderer/src/proof3.test.ts. Those fixtures register models
// through a live SoftwareRenderer; the GPU page registers through
// WebGLRenderer.registerModelData instead, so the numbers are inlined here
// with their derivation (spawn-north origin [128,-320,54], yaw 90) rather
// than imported. The RENDERER, SCENE SELECTOR, SHADERS, MESH BUILDERS,
// APPEARANCE SHADERS (VS_POST/FS_APPEARANCE), MIP-CHAIN BUILDER and PARSERS
// are the real production dists — no reimplementation. The forced-fog hook
// (setFogOverride) is the production test seam: production never calls it
// (null => 0 scene contribution, the base1 rule).
//
// TEST-ONLY CAPTURE: the page calls readPixels to derive coverage/diff
// stats. This is allowed in tests (PROOF-3 done-when). The normal
// production path stays readback-free — pinned by the always-on
// gpu-readback scan in gpu-browser.test.ts (no readPixels in
// packages/webgl-renderer/src/).
//
// This module is a pure string builder (no DOM, no node:*): safe to import
// from the Node harness. NEVER import it from a browser bundle.

/** Map an npm package name to the URL path serving its built dist. */
export type GpuBrowserLibMap = Record<string, string>;

/** Default served set: every production dist the page imports. */
export function gpuBrowserLibPaths(libBase: string): GpuBrowserLibMap {
  const pkgs = [
    'webgl-renderer',
    'sw-renderer',
    'bsp',
    'formats',
    'filesystem',
    'math',
    'config',
    'renderer-api',
  ];
  const out: GpuBrowserLibMap = {};
  for (const p of pkgs) out[`@q2/${p}`] = `${libBase}/${p}/dist/index.mjs`;
  return out;
}

/**
 * Build the full test page HTML. `libMap` maps bare specifiers to served
 * URLs (import map); the asset base (/assets/…) is fixed by the harness
 * server layout.
 */
export function buildProofPageHtml(libMap: GpuBrowserLibMap): string {
  const importMap = JSON.stringify({ imports: libMap });
  return (
    '<!doctype html>\n' +
    '<html><head><meta charset="utf-8"><title>q2 gpu proof</title>\n' +
    '<script type="importmap">' + importMap + '</' + 'script>\n' +
    '</head><body style="margin:0;background:#000">\n' +
    '<canvas id="c" width="640" height="480" style="width:640px;height:480px;margin:0;display:block"></canvas>\n' +
    '<script type="module">\n' +
    PROOF_PAGE_JS +
    '\n</' + 'script>\n' +
    '</body></html>\n'
  );
}

/**
 * The page program. Plain JS (no backticks, no ${} — it is embedded in a
 * TS string). Publishes window.__q2proof when done (or on error).
 */
const PROOF_PAGE_JS = `
'use strict';
import { WebGLRenderer, selectGpuScene, compileProgram, resolveAppearanceFrame } from '@q2/webgl-renderer';
import { VS_LIT, FS_LIT, VS_ALIAS, FS_ALIAS, VS_FLAT, FS_FLAT } from '@q2/webgl-renderer';
import { VS_POST, FS_APPEARANCE, buildMipChainRGB } from '@q2/webgl-renderer';
import { setCVar, setCVarFromString, resetCVars } from '@q2/config';
import { bspToMiniWorld } from '@q2/sw-renderer';
import { loadBsp } from '@q2/bsp';
import { parseWAL, parsePCX, parseMD2 } from '@q2/formats';

var W = 640, H = 480, N = 640 * 480;
var proof = { done: false, error: null };
window.__q2proof = proof;
window.addEventListener('error', function (e) {
  if (!proof.done) { proof.done = true; proof.error = 'window.onerror: ' + e.message; }
});

function f32(a) { return new Float32Array(a); }
function log(s) { try { console.log('[proof-page] ' + s); } catch (e) {} }

// SEAM (see module doc): route/placement duplicated by value from
// bench-workloads.ts + gpu-proof.ts. Spawn-north: origin [128,-320,54],
// yaw 90 (fwd = (cos90, sin90) = (0,1)), fovX 90, time 1.5.
var OX = 128, OY = -320, OZ = 54, YAW = 90;
var YAW_RAD = (YAW * Math.PI) / 180;
var FX = Math.cos(YAW_RAD), FY = Math.sin(YAW_RAD);
var RX = -FY, RY = FX;
var VIEW = {
  origin: f32([OX, OY, OZ]),
  angles: f32([0, YAW, 0]),
  fovX: 90,
  time: 1.5,
  lightStyles: new Float32Array(256).fill(1),
};
// fixedBenchEntities: soldier (md2 0, skin 0) + sprite (sp2 2, skin 0) +
// tracer beam (tracer 1, skin 231 = palette color index).
var E_SOLDIER = { model: 0, origin: f32([OX + FX * 48, OY + FY * 48, OZ - 30]), angles: f32([0, YAW + 180, 0]), frame: 4, skin: 0 };
var E_SPRITE = { model: 2, origin: f32([OX + FX * 48, OY + FY * 48, OZ + 18]), angles: f32([0, 0, 0]), frame: 0, skin: 0 };
var E_BEAM = { model: 1, origin: f32([OX + FX * 40 + RX * 25, OY + FY * 40 + RY * 25, OZ - 10]), angles: f32([0, YAW + 90, 0]), frame: 96, skin: 231 };
// combatBenchEntities: fixed set + eye-anchored depthHack viewmodel gun.
var E_GUN = { model: 3, origin: f32([OX, OY, OZ]), angles: f32([0, YAW, 0]), frame: 4, skin: 1, depthHack: true };
var ENT_F0 = [E_SOLDIER, E_SPRITE, E_BEAM];
var ENT_F1 = [E_SOLDIER, E_SPRITE, E_BEAM, E_GUN];
var KINDS = new Map([[0, 'md2'], [1, 'tracer'], [2, 'sp2'], [3, 'md2']]);
// pumpBenchLights: muzzle flash at the soldier + explosion downrange.
var LIGHTS_F1 = [
  { origin: f32([OX + FX * 48, OY + FY * 48, OZ - 20]), intensity: 250, color: f32([1, 0.55, 0.15]) },
  { origin: f32([OX + FX * 90, OY + FY * 90, OZ - 10]), intensity: 350, color: f32([1, 0.9, 0.7]) },
];
// benchSparkParticles around (soldier x, soldier y, OZ - 20).
var SPARK_COLORS = [8, 70, 200, 231, 250, 180, 33, 99, 150, 210, 240, 15];
function sparkParticles() {
  var cx = OX + FX * 48, cy = OY + FY * 48, cz = OZ - 20;
  var out = [];
  for (var i = 0; i < SPARK_COLORS.length; i++) {
    out.push({
      origin: f32([cx + ((i * 37) % 17) - 8, cy + ((i * 53) % 17) - 8, cz + 10 + ((i * 29) % 25)]),
      color: SPARK_COLORS[i],
    });
  }
  return out;
}

function fetchBuf(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error('fetch ' + url + ': HTTP ' + r.status);
    return r.arrayBuffer();
  });
}

// Counting GL wrapper: bind-fixed passthrough Proxy over the real context.
// opts.forceDepthOff turns enable(DEPTH_TEST) into disable (occlusion probe).
// Per-capture draw deltas come from snapDraws(); __draws is page-only state.
function wrapGL(gl, opts) {
  var draws = { elements: 0, arrays: 0 };
  var proxy = new Proxy(gl, {
    get: function (t, p) {
      if (p === 'enable') return function (cap) {
        if (opts && opts.forceDepthOff && cap === t.DEPTH_TEST) { t.disable(cap); return; }
        t.enable(cap);
      };
      var v = t[p];
      if (typeof v === 'function') {
        if (p === 'drawElements') return function () { draws.elements++; return v.apply(t, arguments); };
        if (p === 'drawArrays') return function () { draws.arrays++; return v.apply(t, arguments); };
        return function () { return v.apply(t, arguments); };
      }
      return v;
    },
  });
  return { gl: proxy, draws: draws };
}

function coverageOf(px) {
  var n = 0;
  for (var i = 0; i < px.length; i += 4) {
    if (px[i] !== 0 || px[i + 1] !== 0 || px[i + 2] !== 0) n++;
  }
  return { covered: n, frac: n / N };
}

// Exact-byte diff + bounding box of differing pixels (GL coords: y=0 is the
// BOTTOM row — readPixels origin). bbox is null when identical.
function diffStats(a, b) {
  var count = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (var i = 0; i < N; i++) {
    var o = i * 4;
    if (a[o] !== b[o] || a[o + 1] !== b[o + 1] || a[o + 2] !== b[o + 2] || a[o + 3] !== b[o + 3]) {
      count++;
      var x = i % W, y = (i / W) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (count === 0) return { count: 0, frac: 0, bbox: null, bboxFrac: 0 };
  var pad = 2;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  var area = (x1 - x0 + 1) * (y1 - y0 + 1);
  return { count: count, frac: count / N, bbox: [x0, y0, x1, y1], bboxArea: area, bboxFrac: count / area };
}

function makeRenderer(glImpl, world, palette, soldierMd2, gunMd2, soldierSkin, gunSkin, entities, view) {
  var v = view || VIEW;
  var r = new WebGLRenderer();
  r.init(glImpl, W, H);
  r.attachWorld(world);
  r.setPalette(palette);
  r.registerModelData(0, 'md2', soldierMd2);
  r.registerModelData(1, 'tracer', null);
  r.registerModelData(2, 'sp2', null);
  r.registerModelData(3, 'md2', gunMd2);
  r.registerSkinPixels(0, soldierSkin.pixels, soldierSkin.width, soldierSkin.height);
  r.registerSkinPixels(1, gunSkin.pixels, gunSkin.width, gunSkin.height);
  var scene = selectGpuScene(world, entities, v, W, H, KINDS);
  r.setScene(scene);
  return { renderer: r, scene: scene };
}

// TEST-ONLY capture: readPixels is forbidden in the production path (pinned
// by the gpu-readback scan); this harness-generated page may capture.
// view overrides the render camera (default VIEW): FOLLOW-2 renders the
// turn selection from the turn view through the same production path.
function renderCapture(rawGL, rr, draws, entities, lights, view) {
  var v = view || VIEW;
  var beforeE = draws.elements, beforeA = draws.arrays;
  rr.renderer.setEntities(entities, KINDS);
  // FOLLOW-2B GL-error phase attribution (test-only drains; production never
  // polls): snapshot sticky flags before the render, after the render
  // (draw-side) and after readPixels (harness-side). Records only the FIRST
  // non-empty occurrence so the proof stays small; the renderer upload polls
  // already attribute texImage2D failures inline.
  var capPre = drainGLErrors(rawGL);
  rr.renderer.renderFrame({ view: v, scene: rr.scene, time: 1.5, lights: lights });
  var capPostDraw = drainGLErrors(rawGL);
  var px = new Uint8Array(N * 4);
  rawGL.readPixels(0, 0, W, H, rawGL.RGBA, rawGL.UNSIGNED_BYTE, px);
  var capPostRead = drainGLErrors(rawGL);
  if (!window.__q2glFirst && (capPre.length + capPostDraw.length + capPostRead.length) > 0) {
    window.__q2glFirst = { pre: capPre, postDraw: capPostDraw, postRead: capPostRead };
  }
  window.__q2capN = (window.__q2capN || 0) + 1;
  return { px: px, draws: (draws.elements - beforeE) + (draws.arrays - beforeA) };
}

function summarize(diff) {
  if (!diff.bbox) return { count: diff.count, frac: diff.frac, bbox: null, bboxFrac: 0 };
  return { count: diff.count, frac: diff.frac, bbox: diff.bbox, bboxArea: diff.bboxArea, bboxFrac: diff.bboxFrac };
}

// FOLLOW-2B error localization: drain all pending GL error flags into an
// array (getError clears one flag per call; un-drained flags are sticky, so
// a single late read cannot attribute the source).
function drainGLErrors(rawGL) {
  var errs = [];
  for (var i = 0; i < 8; i++) {
    var e = rawGL.getError();
    if (e === 0) break;
    errs.push(e);
  }
  return errs;
}

// Centroid of pixels differing by more than tol in any channel (GL coords:
// y=0 is the BOTTOM row). Null when nothing differs. Locates an entity
// class precisely through its removal variant, robust to LSB noise.
function centroidOf(a, b, tol) {
  var sx = 0, sy = 0, n = 0;
  for (var i = 0; i < N; i++) {
    var o = i * 4;
    var dr = Math.abs(a[o] - b[o]);
    var dg = Math.abs(a[o + 1] - b[o + 1]);
    var db = Math.abs(a[o + 2] - b[o + 2]);
    if (dr > tol || dg > tol || db > tol) {
      sx += i % W; sy += (i / W) | 0; n++;
    }
  }
  if (n === 0) return null;
  return { x: sx / n, y: sy / n, n: n };
}

async function main() {
  var canvas = document.getElementById('c');
  var rawGL = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: true, stencil: false });
  if (!rawGL) throw new Error('no webgl2 context (getContext returned null)');
  var version = String(rawGL.getParameter(rawGL.VERSION));
  proof.webgl2 = version.indexOf('WebGL 2.0') !== -1;
  proof.glVersion = version;
  proof.glRenderer = String(rawGL.getParameter(rawGL.RENDERER));
  proof.glVendor = String(rawGL.getParameter(rawGL.VENDOR));
  log('context: ' + version + ' | ' + proof.glRenderer);
  if (!proof.webgl2) throw new Error('not WebGL2: ' + version);

  // Production shader compile check (compileProgram throws with the log).
  var specs = [['lit', VS_LIT, FS_LIT], ['alias', VS_ALIAS, FS_ALIAS], ['flat', VS_FLAT, FS_FLAT]];
  proof.programs = [];
  for (var si = 0; si < specs.length; si++) {
    var name = specs[si][0];
    try {
      var prog = compileProgram(rawGL, specs[si][1], specs[si][2]);
      var linked = rawGL.getProgramParameter(prog, rawGL.LINK_STATUS);
      var plog = String(rawGL.getProgramInfoLog(prog) || '');
      proof.programs.push({ name: name, compiled: true, linked: !!linked, logLength: plog.length });
      rawGL.deleteProgram(prog);
      if (!linked) throw new Error('program ' + name + ' link failed: ' + plog.slice(0, 300));
    } catch (e) {
      proof.programs.push({ name: name, compiled: false, linked: false, log: String((e && e.message) || e).slice(0, 500) });
    }
  }
  log('programs: ' + JSON.stringify(proof.programs));

  // Assets (served by the harness from the real pak0.pak).
  log('fetching base1.bsp...');
  var map = loadBsp(await fetchBuf('/assets/maps/base1.bsp'));
  var names = {};
  for (var ti = 0; ti < map.texinfoNames.length; ti++) names[map.texinfoNames[ti]] = true;
  var walNames = Object.keys(names);
  log('wal count: ' + walNames.length);
  var walBufs = await Promise.all(walNames.map(function (n) {
    return fetchBuf('/assets/textures/' + n + '.wal').then(
      function (b) { return b; },
      function () { return null; }
    );
  }));
  var walStore = {};
  for (var wi = 0; wi < walNames.length; wi++) walStore[walNames[wi]] = walBufs[wi];
  function texelFor(walName) {
    var buf = walStore[walName];
    if (!buf) return null;
    try {
      var wal = parseWAL(buf);
      return { texels: wal.mips[0], width: wal.width, height: wal.height };
    } catch (e) { return null; }
  }
  var world = bspToMiniWorld(map, { texelFor: texelFor });
  var palette = parsePCX(await fetchBuf('/assets/pics/colormap.pcx')).palette;
  var soldierMd2 = parseMD2(await fetchBuf('/assets/models/monsters/soldier/tris.md2'));
  var gunMd2 = parseMD2(await fetchBuf('/assets/models/weapons/v_blast/tris.md2'));
  var soldierSkin = parsePCX(await fetchBuf('/assets/models/monsters/soldier/skin.pcx'));
  var gunSkin = parsePCX(await fetchBuf('/assets/models/weapons/v_blast/skin.pcx'));
  log('assets ok: surfaces=' + world.surfaces.length);

  var worldF0 = world;
  worldF0.particles = [];
  var worldF1 = Object.assign({}, world, { particles: sparkParticles() });

  // One counting wrapper for the depth-on renders, one depth-forced-off
  // wrapper for the occlusion probe (same raw context underneath).
  var counted = wrapGL(rawGL, null);
  var noDepth = wrapGL(rawGL, { forceDepthOff: true });
  var rrF0 = makeRenderer(counted.gl, worldF0, palette, soldierMd2, gunMd2, soldierSkin, gunSkin, ENT_F0);
  var rrF1 = makeRenderer(counted.gl, worldF1, palette, soldierMd2, gunMd2, soldierSkin, gunSkin, ENT_F1);
  var rrNoDepth = makeRenderer(noDepth.gl, worldF1, palette, soldierMd2, gunMd2, soldierSkin, gunSkin, ENT_F1);

  // Warmup: two throwaway F1 renders per renderer past the first-frame
  // settle (documented SwiftShader behavior: the first submit after upload
  // differs by LSBs from the steady state; production code is untouched).
  for (var wq = 0; wq < 2; wq++) {
    rrF1.renderer.setEntities(ENT_F1, KINDS);
    rrF1.renderer.renderFrame({ view: VIEW, scene: rrF1.scene, time: 1.5, lights: LIGHTS_F1 });
    rrNoDepth.renderer.setEntities(ENT_F1, KINDS);
    rrNoDepth.renderer.renderFrame({ view: VIEW, scene: rrNoDepth.scene, time: 1.5, lights: LIGHTS_F1 });
  }

  var worldRefs = 0, entityRefs = 0;
  for (var ri = 0; ri < rrF1.scene.surfaces.length; ri++) {
    if (rrF1.scene.surfaces[ri].transformIndex === 0) worldRefs++; else entityRefs++;
  }
  proof.scene = { surfaces: rrF1.scene.surfaces.length, worldRefs: worldRefs, entityRefs: entityRefs };

  var capF0 = renderCapture(rawGL, rrF0, counted.draws, ENT_F0, []);
  var capF1 = renderCapture(rawGL, rrF1, counted.draws, ENT_F1, LIGHTS_F1);
  // Determinism probe: the identical frame rendered twice back-to-back must
  // be byte-identical (PROOF-3 shaders carry no dither/phase). A non-zero
  // diff here means renderer nondeterminism, not variant effects.
  var capF1b = renderCapture(rawGL, rrF1, counted.draws, ENT_F1, LIGHTS_F1);
  var noGun = [E_SOLDIER, E_SPRITE, E_BEAM];
  var noBeam = [E_SOLDIER, E_SPRITE, E_GUN];
  var noSoldier = [E_SPRITE, E_BEAM, E_GUN];
  var noSprite = [E_SOLDIER, E_BEAM, E_GUN];
  var capNoGun = renderCapture(rawGL, rrF1, counted.draws, noGun, LIGHTS_F1);
  var capNoBeam = renderCapture(rawGL, rrF1, counted.draws, noBeam, LIGHTS_F1);
  var capNoSoldier = renderCapture(rawGL, rrF1, counted.draws, noSoldier, LIGHTS_F1);
  var capNoSprite = renderCapture(rawGL, rrF1, counted.draws, noSprite, LIGHTS_F1);
  var capNoDepth = renderCapture(rawGL, rrNoDepth, noDepth.draws, ENT_F1, LIGHTS_F1);

  // FOLLOW-2 moving-camera checks (same origin, 180-degree turn): a fresh
  // renderer over the turn selection, plus a same-renderer re-selection
  // (fresh turn scene at the boot generation, no re-upload) that must render
  // byte-identical to the fresh turn renderer. The frozen spawn-subset path
  // fails this: the re-selected capture then repeats the spawn subset.
  var TURN_VIEW = {
    origin: f32([OX, OY, OZ]),
    angles: f32([0, YAW + 180, 0]),
    fovX: 90,
    time: 1.5,
    lightStyles: VIEW.lightStyles,
  };
  var rrTurn = makeRenderer(counted.gl, worldF1, palette, soldierMd2, gunMd2, soldierSkin, gunSkin, ENT_F1, TURN_VIEW);
  // Same first-submit settle as the F1 warmup above (SwiftShader LSB drift
  // on the first submit after upload): two throwaway turn renders first.
  for (var wq2 = 0; wq2 < 2; wq2++) {
    rrTurn.renderer.setEntities(ENT_F1, KINDS);
    rrTurn.renderer.renderFrame({ view: TURN_VIEW, scene: rrTurn.scene, time: 1.5, lights: LIGHTS_F1 });
  }
  var capTurn = renderCapture(rawGL, rrTurn, counted.draws, ENT_F1, LIGHTS_F1, TURN_VIEW);
  var savedF1Scene = rrF1.scene;
  var uploadsBeforeReselect = rrF1.renderer.testUploadStats().uploads;
  var turnScene = selectGpuScene(worldF1, ENT_F1, TURN_VIEW, W, H, KINDS);
  rrF1.renderer.setScene(turnScene);
  rrF1.scene = turnScene;
  var capReselect = renderCapture(rawGL, rrF1, counted.draws, ENT_F1, LIGHTS_F1, TURN_VIEW);
  var uploadsAfterReselect = rrF1.renderer.testUploadStats().uploads;
  // Restore the F1 scene on the combat renderer for the suites below.
  rrF1.renderer.setScene(savedF1Scene);
  rrF1.scene = savedF1Scene;
  var covTurn = coverageOf(capTurn.px);

  var covF0 = coverageOf(capF0.px);
  var covF1 = coverageOf(capF1.px);
  proof.stats = {
    drawsF0: capF0.draws,
    drawsF1: capF1.draws,
    coverageF0: covF0,
    coverageF1: covF1,
    f1vsF1b: summarize(diffStats(capF1.px, capF1b.px)),
    f0vsF1: summarize(diffStats(capF0.px, capF1.px)),
    gun: summarize(diffStats(capF1.px, capNoGun.px)),
    beam: summarize(diffStats(capF1.px, capNoBeam.px)),
    soldier: summarize(diffStats(capF1.px, capNoSoldier.px)),
    sprite: summarize(diffStats(capF1.px, capNoSprite.px)),
    depthOff: summarize(diffStats(capF1.px, capNoDepth.px)),
    // FOLLOW-2: the turn view covers real geometry (not a void), differs
    // from the spawn view (the camera actually moved), and the same-renderer
    // re-selection matches the fresh turn renderer exactly (selection
    // update without re-upload).
    coverageTurn: covTurn,
    drawsTurn: capTurn.draws,
    turnVsF0: summarize(diffStats(capTurn.px, capF0.px)),
    reselectVsFresh: summarize(diffStats(capReselect.px, capTurn.px)),
    uploadsReselect: { before: uploadsBeforeReselect, after: uploadsAfterReselect },
    // >24-centroids (GL coords, y=0 bottom) pin each class on screen.
    centroidGun: centroidOf(capF1.px, capNoGun.px, 24),
    centroidBeam: centroidOf(capF1.px, capNoBeam.px, 24),
    centroidSoldier: centroidOf(capF1.px, capNoSoldier.px, 24),
    centroidSprite: centroidOf(capF1.px, capNoSprite.px, 24),
  };
  proof.warningsF1 = rrF1.renderer.testWarnings().slice(0, 20);
  proof.uploadsF1 = rrF1.renderer.testUploadStats();
  log('stats: ' + JSON.stringify(proof.stats));
  log('warnings: ' + JSON.stringify(proof.warningsF1));

  // --- PROOF-4 appearance fixtures (pinned profile + production pass) ---
  // pinBenchCvars-equivalent in-page (values duplicated BY VALUE from
  // bench-workloads.ts pinBenchCvars): the appearance backend reads vd_*
  // live per frame (resolveAppearanceFrame), so driving cvars through
  // @q2/config IS the supported seam — no setter API exists by design.
  // Config defaults already match the pinned profile; the explicit pin
  // proves seam neutrality (f1PinnedVsF1 below must equal the unpinned F1).
  resetCVars();
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

  // (a) gradient + flat-field ramps through the PRODUCTION appearance
  // shader (VS_POST/FS_APPEARANCE from the built dist, postfilter OFF so
  // the raw dither+565 quantum is observed, gamma 1.0 to isolate it).
  var postProg = compileProgram(rawGL, VS_POST, FS_APPEARANCE);
  function postUniforms(ditherOn, gamma) {
    rawGL.useProgram(postProg);
    rawGL.uniform1i(rawGL.getUniformLocation(postProg, 'uScene'), 0);
    rawGL.uniform1i(rawGL.getUniformLocation(postProg, 'uDitherOn'), ditherOn ? 1 : 0);
    rawGL.uniform1i(rawGL.getUniformLocation(postProg, 'uDitherMode'), 1);
    rawGL.uniform1i(rawGL.getUniformLocation(postProg, 'uPostfilter'), 0);
    rawGL.uniform1i(rawGL.getUniformLocation(postProg, 'uReconMode'), 1);
    rawGL.uniform3f(rawGL.getUniformLocation(postProg, 'uRgbMaxDelta'), 0, 0, 0);
    rawGL.uniform1f(rawGL.getUniformLocation(postProg, 'uGamma'), gamma);
    rawGL.uniform1i(rawGL.getUniformLocation(postProg, 'u16bit'), 1);
  }
  function uploadGrayTex(w, h, fill) {
    var data = new Uint8Array(w * h * 4);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var vv = fill(x, y), o = (y * w + x) * 4;
        data[o] = vv; data[o + 1] = vv; data[o + 2] = vv; data[o + 3] = 255;
      }
    }
    var tex = rawGL.createTexture();
    rawGL.bindTexture(rawGL.TEXTURE_2D, tex);
    rawGL.texParameteri(rawGL.TEXTURE_2D, rawGL.TEXTURE_MIN_FILTER, rawGL.NEAREST);
    rawGL.texParameteri(rawGL.TEXTURE_2D, rawGL.TEXTURE_MAG_FILTER, rawGL.NEAREST);
    rawGL.texParameteri(rawGL.TEXTURE_2D, rawGL.TEXTURE_WRAP_S, rawGL.CLAMP_TO_EDGE);
    rawGL.texParameteri(rawGL.TEXTURE_2D, rawGL.TEXTURE_WRAP_T, rawGL.CLAMP_TO_EDGE);
    rawGL.texImage2D(rawGL.TEXTURE_2D, 0, rawGL.RGBA8, w, h, 0, rawGL.RGBA, rawGL.UNSIGNED_BYTE, data);
    return tex;
  }
  // Expand565 membership sets (voodoo expandRGB565 bit-replication values).
  var SET5 = {}, SET6 = {};
  for (var q5 = 0; q5 < 32; q5++) SET5[((q5 << 3) | (q5 >> 2))] = 1;
  for (var q6 = 0; q6 < 64; q6++) SET6[((q6 << 2) | (q6 >> 4))] = 1;
  // Resolved-region mask (PROOF-4 finding: VS_POST emits a HALF-screen
  // triangle — NDC vertices (-1,-1),(1,-1),(-1,1), i.e. x+y<=0 — so the
  // appearance pass resolves only that half; the rest is stale. Fixture
  // stats below count COVERED pixels only; resolveCoverage pins the defect
  // for the owning lane. Covered (pixel centers, gl_FragCoord space):
  // (x+0.5)/vpW + (y+0.5)/vpH <= 1, y measured UP from the bottom row.
  function coveredAt(x, y, vpW, vpH) {
    return ((x + 0.5) / vpW + (y + 0.5) / vpH) <= 1;
  }
  function coveredCount(w, h, vpW, vpH) {
    var n = 0;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (coveredAt(x, y, vpW, vpH)) n++;
      }
    }
    return n;
  }
  var RW = 256, RH = 8, FW = 64;
  var rampTex = uploadGrayTex(RW, RH, function (x) { return x; });
  var flatTex = uploadGrayTex(FW, RH, function () { return 100; });
  var rampFBO = rawGL.createFramebuffer();
  var rampTarget = rawGL.createTexture();
  rawGL.bindTexture(rawGL.TEXTURE_2D, rampTarget);
  rawGL.texParameteri(rawGL.TEXTURE_2D, rawGL.TEXTURE_MIN_FILTER, rawGL.NEAREST);
  rawGL.texParameteri(rawGL.TEXTURE_2D, rawGL.TEXTURE_MAG_FILTER, rawGL.NEAREST);
  rawGL.texParameteri(rawGL.TEXTURE_2D, rawGL.TEXTURE_WRAP_S, rawGL.CLAMP_TO_EDGE);
  rawGL.texParameteri(rawGL.TEXTURE_2D, rawGL.TEXTURE_WRAP_T, rawGL.CLAMP_TO_EDGE);
  rawGL.texImage2D(rawGL.TEXTURE_2D, 0, rawGL.RGBA8, RW, RH, 0, rawGL.RGBA, rawGL.UNSIGNED_BYTE, null);
  rawGL.bindFramebuffer(rawGL.FRAMEBUFFER, rampFBO);
  rawGL.framebufferTexture2D(rawGL.FRAMEBUFFER, rawGL.COLOR_ATTACHMENT0, rawGL.TEXTURE_2D, rampTarget, 0);
  var rampStatus = rawGL.checkFramebufferStatus(rawGL.FRAMEBUFFER);
  if (rampStatus !== rawGL.FRAMEBUFFER_COMPLETE) throw new Error('ramp FBO incomplete: ' + rampStatus);
  function runPost(srcTex, w, h, ditherOn, gamma, dstFBO) {
    rawGL.bindFramebuffer(rawGL.FRAMEBUFFER, dstFBO || rampFBO);
    rawGL.viewport(0, 0, w, h);
    rawGL.activeTexture(rawGL.TEXTURE0);
    rawGL.bindTexture(rawGL.TEXTURE_2D, srcTex);
    postUniforms(ditherOn, gamma);
    rawGL.drawArrays(rawGL.TRIANGLES, 0, 3);
    var px = new Uint8Array(w * h * 4);
    rawGL.readPixels(0, 0, w, h, rawGL.RGBA, rawGL.UNSIGNED_BYTE, px);
    return px;
  }
  // All small-field stats count COVERED pixels only (see coveredAt): the
  // void half carries stale zeros, never shader output.
  function triplesOfMasked(px, w, h, vpW, vpH) {
    var seen = {}, n = 0;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (!coveredAt(x, y, vpW, vpH)) continue;
        var i = (y * w + x) * 4;
        var k = px[i] * 65536 + px[i + 1] * 256 + px[i + 2];
        if (!seen[k]) { seen[k] = 1; n++; }
      }
    }
    return n;
  }
  function channelsOfMasked(px, w, h, vpW, vpH) {
    var sr = {}, sg = {}, sb = {}, nr = 0, ng = 0, nb = 0;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (!coveredAt(x, y, vpW, vpH)) continue;
        var i = (y * w + x) * 4;
        if (!sr[px[i]]) { sr[px[i]] = 1; nr++; }
        if (!sg[px[i + 1]]) { sg[px[i + 1]] = 1; ng++; }
        if (!sb[px[i + 2]]) { sb[px[i + 2]] = 1; nb++; }
      }
    }
    return { r: nr, g: ng, b: nb };
  }
  function membershipViolationsMasked(px, w, h, vpW, vpH) {
    var v = 0;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (!coveredAt(x, y, vpW, vpH)) continue;
        var i = (y * w + x) * 4;
        if (!SET5[px[i]] || !SET6[px[i + 1]] || !SET5[px[i + 2]]) v++;
      }
    }
    return v;
  }
  function periodViolationsMasked(px, w, h, vpW, vpH) {
    var v = 0;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (!coveredAt(x, y, vpW, vpH)) continue;
        var a = (y * w + x) * 4, b, c;
        if (x + 4 < w && coveredAt(x + 4, y, vpW, vpH)) {
          b = (y * w + x + 4) * 4;
          if (px[a] !== px[b] || px[a + 1] !== px[b + 1] || px[a + 2] !== px[b + 2]) v++;
        }
        if (y + 4 < h && coveredAt(x, y + 4, vpW, vpH)) {
          c = ((y + 4) * w + x) * 4;
          if (px[a] !== px[c] || px[a + 1] !== px[c + 1] || px[a + 2] !== px[c + 2]) v++;
        }
      }
    }
    return v;
  }
  function diffStatsWHMasked(a, b, w, h, vpW, vpH) {
    var n = 0, count = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (!coveredAt(x, y, vpW, vpH)) continue;
        n++;
        var o = (y * w + x) * 4;
        if (a[o] !== b[o] || a[o + 1] !== b[o + 1] || a[o + 2] !== b[o + 2] || a[o + 3] !== b[o + 3]) {
          count++;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (count === 0) return { count: 0, frac: 0, bbox: null, bboxFrac: 0, covered: n };
    var pad = 2;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
    var area = (x1 - x0 + 1) * (y1 - y0 + 1);
    return { count: count, frac: n === 0 ? 0 : count / n, bbox: [x0, y0, x1, y1], bboxArea: area, bboxFrac: count / area, covered: n };
  }
  var flatOn = runPost(flatTex, FW, RH, true, 1.0, null);
  var flatOff = runPost(flatTex, FW, RH, false, 1.0, null);
  var rampOn = runPost(rampTex, RW, RH, true, 1.0, null);
  var rampOff = runPost(rampTex, RW, RH, false, 1.0, null);
  var rampGamma = runPost(rampTex, RW, RH, true, 1.3, null);
  // Full-canvas resolve coverage: fresh 640x480 target (zeros) + flat field
  // through the production pass. Resolved pixels are ~100 gray, never zero;
  // stale zeros mark the unresolved region. A correct fullscreen pass reads
  // ~1.0 (pinned by RESOLVE_COVERAGE_MIN in the test).
  var covTex = uploadGrayTex(W, H, function () { return 100; });
  var covTarget = rawGL.createTexture();
  rawGL.bindTexture(rawGL.TEXTURE_2D, covTarget);
  rawGL.texParameteri(rawGL.TEXTURE_2D, rawGL.TEXTURE_MIN_FILTER, rawGL.NEAREST);
  rawGL.texParameteri(rawGL.TEXTURE_2D, rawGL.TEXTURE_MAG_FILTER, rawGL.NEAREST);
  rawGL.texParameteri(rawGL.TEXTURE_2D, rawGL.TEXTURE_WRAP_S, rawGL.CLAMP_TO_EDGE);
  rawGL.texParameteri(rawGL.TEXTURE_2D, rawGL.TEXTURE_WRAP_T, rawGL.CLAMP_TO_EDGE);
  rawGL.texImage2D(rawGL.TEXTURE_2D, 0, rawGL.RGBA8, W, H, 0, rawGL.RGBA, rawGL.UNSIGNED_BYTE, null);
  var covFBO = rawGL.createFramebuffer();
  rawGL.bindFramebuffer(rawGL.FRAMEBUFFER, covFBO);
  rawGL.framebufferTexture2D(rawGL.FRAMEBUFFER, rawGL.COLOR_ATTACHMENT0, rawGL.TEXTURE_2D, covTarget, 0);
  var covStatus = rawGL.checkFramebufferStatus(rawGL.FRAMEBUFFER);
  if (covStatus !== rawGL.FRAMEBUFFER_COMPLETE) throw new Error('coverage FBO incomplete: ' + covStatus);
  var covPx = runPost(covTex, W, H, true, 1.0, covFBO);
  var covResolved = 0;
  for (var ci = 0; ci < covPx.length; ci += 4) {
    if (covPx[ci] !== 0 || covPx[ci + 1] !== 0 || covPx[ci + 2] !== 0) covResolved++;
  }
  rawGL.bindFramebuffer(rawGL.FRAMEBUFFER, null);
  rawGL.viewport(0, 0, W, H);
  // Small-field debug evidence (12 KB total): raw ramp/flat captures for
  // Node-side root-cause analysis (fixture assumption vs shader behavior).
  window.__q2rampDbg = {
    flatOn: Array.prototype.slice.call(flatOn),
    flatOff: Array.prototype.slice.call(flatOff),
    rampOn: Array.prototype.slice.call(rampOn),
    rampOff: Array.prototype.slice.call(rampOff),
  };
  var rampChOn = channelsOfMasked(rampOn, RW, RH, RW, RH);
  proof.appearance = {
    flatDistinctOn: triplesOfMasked(flatOn, FW, RH, FW, RH),
    flatDistinctOff: triplesOfMasked(flatOff, FW, RH, FW, RH),
    flatPeriodViolations: periodViolationsMasked(flatOn, FW, RH, FW, RH),
    flatMembershipViolations: membershipViolationsMasked(flatOn, FW, RH, FW, RH),
    flatOnVsOff: diffStatsWHMasked(flatOn, flatOff, FW, RH, FW, RH),
    flatCovered: coveredCount(FW, RH, FW, RH),
    rampDistinctR: rampChOn.r,
    rampDistinctG: rampChOn.g,
    rampDistinctB: rampChOn.b,
    rampTriplesOn: triplesOfMasked(rampOn, RW, RH, RW, RH),
    rampTriplesOff: triplesOfMasked(rampOff, RW, RH, RW, RH),
    rampMembershipViolations: membershipViolationsMasked(rampOn, RW, RH, RW, RH),
    rampGammaVsLinear: diffStatsWHMasked(rampGamma, rampOn, RW, RH, RW, RH),
    rampCovered: coveredCount(RW, RH, RW, RH),
    resolveCoverage: covResolved / (W * H),
  };

  // (c) mip chain through the PRODUCTION upload-time builder (asset-free
  // 64x64 8px checker) + live dither contrast at a minified camera.
  var checker = new Uint8Array(64 * 64 * 3);
  for (var mcy = 0; mcy < 64; mcy++) {
    for (var mcx = 0; mcx < 64; mcx++) {
      var mcv = ((((mcx >> 3) + (mcy >> 3)) & 1) !== 0) ? 255 : 0;
      var mco = (mcy * 64 + mcx) * 3;
      checker[mco] = mcv; checker[mco + 1] = mcv; checker[mco + 2] = mcv;
    }
  }
  var mipChain = buildMipChainRGB(checker, 64, 64);
  var mipLast = mipChain[mipChain.length - 1];
  proof.mipChain = {
    levels: mipChain.length,
    lastW: mipLast.w,
    lastH: mipLast.h,
    lastMean: [mipLast.data[0], mipLast.data[1], mipLast.data[2]],
  };
  var FAR_VIEW = {
    origin: f32([OX - FX * 150, OY - FY * 150, OZ + 40]),
    angles: VIEW.angles,
    fovX: 90,
    time: 1.5,
    lightStyles: VIEW.lightStyles,
  };
  var rrFar = makeRenderer(counted.gl, worldF1, palette, soldierMd2, gunMd2, soldierSkin, gunSkin, ENT_F1, FAR_VIEW);
  // FOLLOW-2B checkpoint: drain before far/mip captures to see whether any
  // GL flag predates them (sticky flags otherwise misattribute).
  var glErrorsPreFar = drainGLErrors(rawGL);
  var capFarOn = renderCapture(rawGL, rrFar, counted.draws, ENT_F1, LIGHTS_F1);
  setCVar('vd_mipdither', 0);
  var capFarOff = renderCapture(rawGL, rrFar, counted.draws, ENT_F1, LIGHTS_F1);
  setCVar('vd_mipdither', 1);
  // FOLLOW-2B hypothesis check (the far fixture above renders the
  // far-selected scene from the NEAR camera by default): render the same
  // scene from its own FAR camera, where minification is real. If the
  // atlas-isolation fix is sound, the far camera shows proper minified
  // content and the dither toggle bites there — while the near-camera far
  // captures legitimately depth-resolve to F1.
  var capFarViewOn = renderCapture(rawGL, rrFar, counted.draws, ENT_F1, LIGHTS_F1, FAR_VIEW);
  var mipFlagOn = resolveAppearanceFrame().mipDither;
  setCVar('vd_mipdither', 0);
  var capFarViewOff = renderCapture(rawGL, rrFar, counted.draws, ENT_F1, LIGHTS_F1, FAR_VIEW);
  var mipFlagOff = resolveAppearanceFrame().mipDither;
  setCVar('vd_mipdither', 1);

  // (d) pinned F1 fixed-scene capture (the CPU-vs-GPU comparison input) +
  // (b) FORCED-fog ramp (setFogOverride IS the supported seam: production
  // never calls it; null => 0 contribution, the base1 rule) + pinned
  // transparent-overlap / depth-tie re-captures through the appearance pass.
  var capF1P = renderCapture(rawGL, rrF1, counted.draws, ENT_F1, LIGHTS_F1);
  window.__q2capF1 = capF1P.px;
  window.__q2capSlice = function (a, b) { return Array.prototype.slice.call(window.__q2capF1.subarray(a, b)); };
  // FOLLOW-2B dither-liveness probe (near camera, F1 scene): the dither
  // toggle must perturb mid-distance textured content if the uMipDither
  // path is alive. A zero here means globally dead dither (regression);
  // nonzero with zero far response means minified taps have converged to
  // per-tile averages (bleed removal working, fixture testing the wrong
  // regime).
  setCVar('vd_mipdither', 0);
  var capF1DitherOff = renderCapture(rawGL, rrF1, counted.draws, ENT_F1, LIGHTS_F1);
  var mipFlagF1Off = resolveAppearanceFrame().mipDither;
  setCVar('vd_mipdither', 1);
  // FOLLOW-2B same-camera triage (test-only diagnostic views, production
  // stays 0): diffuse-only, lightmap-only, then final at the SAME camera.
  // Identifies which stage owns any black region (wrap/upload vs atlas).
  // Drain pre-existing flags first so post-triage errors attribute cleanly.
  var glErrorsPreTriage = drainGLErrors(rawGL);
  rrF1.renderer.setDebugView(1);
  var capDiffuse = renderCapture(rawGL, rrF1, counted.draws, ENT_F1, LIGHTS_F1);
  rrF1.renderer.setDebugView(2);
  var capLight = renderCapture(rawGL, rrF1, counted.draws, ENT_F1, LIGHTS_F1);
  rrF1.renderer.setDebugView(0);
  window.__q2capDiffuse = capDiffuse.px;
  window.__q2capLight = capLight.px;
  function brightStats(px) {
    var sum = 0, nonblack = 0;
    for (var bi = 0; bi < N; bi++) {
      var bo = bi * 4;
      var lum = (px[bo] + px[bo + 1] + px[bo + 2]) / 3;
      sum += lum;
      if (px[bo] > 4 || px[bo + 1] > 4 || px[bo + 2] > 4) nonblack++;
    }
    return { mean: sum / N, nonblackFrac: nonblack / N };
  }
  var atlasStats = rrF1.renderer.testAtlasStats();
  var matStats = rrF1.renderer.testMaterialStats();
  var policyUp = rrF1.renderer.testPolicyUploads();
  var glFirst = window.__q2glFirst || null;
  var warnList = rrF1.renderer.testWarnings();
  var uploadErrs = [];
  var preExistingErrs = [];
  for (var wi = 0; wi < warnList.length; wi++) {
    if (warnList[wi].indexOf('texture upload') === 0) uploadErrs.push(warnList[wi]);
    else if (warnList[wi].indexOf('pre-existing GL error') === 0) preExistingErrs.push(warnList[wi]);
  }
  proof.follow2b = {
    diffuse: brightStats(capDiffuse.px),
    light: brightStats(capLight.px),
    final: brightStats(capF1P.px),
    diffuseVsFinal: summarize(diffStats(capDiffuse.px, capF1P.px)),
    lightVsFinal: summarize(diffStats(capLight.px, capF1P.px)),
    farView: brightStats(capFarViewOn.px),
    farViewVsNear: summarize(diffStats(capFarViewOn.px, capF1P.px)),
    farViewMipOnOff: summarize(diffStats(capFarViewOn.px, capFarViewOff.px)),
    f1MipOnOff: summarize(diffStats(capF1P.px, capF1DitherOff.px)),
    mipFlags: [mipFlagOn, mipFlagOff],
    mipFlagF1Off: mipFlagF1Off,
    atlas: atlasStats,
    materials: matStats,
    policyUploads: policyUp,
    glFirstErrors: glFirst,
    warnings: warnList.slice(0, 20),
    warningCount: warnList.length,
    uploadErrors: uploadErrs,
    preExistingGLErrors: preExistingErrs,
    glErrorsPreFar: typeof glErrorsPreFar !== 'undefined' ? glErrorsPreFar : null,
    glErrorsPreTriage: glErrorsPreTriage,
    glErrorsPostTriage: drainGLErrors(rawGL),
    glErrorAfterCaptures: rawGL.getError(),
  };
  log('follow2b: ' + JSON.stringify(proof.follow2b));
  rrF1.renderer.setFogOverride(1, [0.4, 0.5, 0.6]);
  var capFog = renderCapture(rawGL, rrF1, counted.draws, ENT_F1, LIGHTS_F1);
  rrF1.renderer.setFogOverride(null);
  var capFogOff = renderCapture(rawGL, rrF1, counted.draws, ENT_F1, LIGHTS_F1);
  var capPinnedNoBeam = renderCapture(rawGL, rrF1, counted.draws, noBeam, LIGHTS_F1);
  var capPinnedNoDepth = renderCapture(rawGL, rrNoDepth, noDepth.draws, ENT_F1, LIGHTS_F1);
  proof.appearance.fogVsOff = summarize(diffStats(capFog.px, capFogOff.px));
  proof.appearance.fogOffIdentity = summarize(diffStats(capFogOff.px, capF1P.px));
  proof.appearance.farVsNear = summarize(diffStats(capFarOn.px, capF1P.px));
  proof.appearance.mipOnOff = summarize(diffStats(capFarOn.px, capFarOff.px));
  proof.appearance.f1PinnedVsF1 = summarize(diffStats(capF1P.px, capF1.px));
  proof.appearance.pinnedBeam = summarize(diffStats(capF1P.px, capPinnedNoBeam.px));
  proof.appearance.pinnedDepth = summarize(diffStats(capF1P.px, capPinnedNoDepth.px));
  proof.appearance.drawsFar = capFarOn.draws;
  log('appearance: ' + JSON.stringify(proof.appearance));
  log('mipChain: ' + JSON.stringify(proof.mipChain));

  // Timing loop: production path only (renderFrame, no readPixels inside).
  // >=120 rAF samples of the F1 combat frame on the depth-on renderer.
  var input = { view: VIEW, scene: rrF1.scene, time: 1.5, lights: LIGHTS_F1 };
  rrF1.renderer.setEntities(ENT_F1, KINDS);
  var dts = [];
  var last = 0, frames = 0;
  var TARGET = 130;
  await new Promise(function (resolve) {
    function tick(t) {
      if (last !== 0) dts.push(t - last);
      last = t;
      rrF1.renderer.renderFrame(input);
      frames++;
      if (frames < TARGET) requestAnimationFrame(tick);
      else resolve(null);
    }
    requestAnimationFrame(tick);
  });
  dts.sort(function (a, b) { return a - b; });
  function q(p) { return dts[Math.min(dts.length - 1, Math.floor(p * (dts.length - 1)))]; }
  var sum = 0;
  for (var di = 0; di < dts.length; di++) sum += dts[di];
  proof.timings = {
    frames: dts.length,
    min: dts[0], median: q(0.5), p95: q(0.95), max: dts[dts.length - 1],
    mean: sum / dts.length,
  };
  log('timings: ' + JSON.stringify(proof.timings));
  // Sampled AFTER the timing loop: 5 captures + TARGET timing renders.
  proof.framesSubmitted = rrF1.renderer.getStatus().framesSubmitted;

  proof.done = true;
}

main().then(
  function () {},
  function (e) {
    proof.done = true;
    proof.error = String((e && e.stack) || (e && e.message) || e).slice(0, 2000);
    try { console.log('[proof-page] FATAL ' + proof.error); } catch (x) {}
  }
);
`;
