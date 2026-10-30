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
// gpuProofViewFor (packages/testkit/src/gpu-proof.ts), mirroring the F1 leg
// of packages/webgl-renderer/src/proof3.test.ts. Those fixtures register
// models through a live SoftwareRenderer; the GPU page registers through
// WebGLRenderer.registerModelData instead, so the numbers are inlined here
// with their derivation (spawn-north origin [128,-320,54], yaw 90) rather
// than imported. The RENDERER, SCENE SELECTOR, SHADERS, MESH BUILDERS and
// PARSERS are the real production dists — no reimplementation.
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
import { WebGLRenderer, selectGpuScene, compileProgram } from '@q2/webgl-renderer';
import { VS_LIT, FS_LIT, VS_ALIAS, FS_ALIAS, VS_FLAT, FS_FLAT } from '@q2/webgl-renderer';
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

function makeRenderer(glImpl, world, palette, soldierMd2, gunMd2, soldierSkin, gunSkin, entities) {
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
  var scene = selectGpuScene(world, entities, VIEW, W, H, KINDS);
  r.setScene(scene);
  return { renderer: r, scene: scene };
}

// TEST-ONLY capture: readPixels is forbidden in the production path (pinned
// by the gpu-readback scan); this harness-generated page may capture.
function renderCapture(rawGL, rr, draws, entities, lights) {
  var beforeE = draws.elements, beforeA = draws.arrays;
  rr.renderer.setEntities(entities, KINDS);
  rr.renderer.renderFrame({ view: VIEW, scene: rr.scene, time: 1.5, lights: lights });
  var px = new Uint8Array(N * 4);
  rawGL.readPixels(0, 0, W, H, rawGL.RGBA, rawGL.UNSIGNED_BYTE, px);
  return { px: px, draws: (draws.elements - beforeE) + (draws.arrays - beforeA) };
}

function summarize(diff) {
  if (!diff.bbox) return { count: diff.count, frac: diff.frac, bbox: null, bboxFrac: 0 };
  return { count: diff.count, frac: diff.frac, bbox: diff.bbox, bboxArea: diff.bboxArea, bboxFrac: diff.bboxFrac };
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
