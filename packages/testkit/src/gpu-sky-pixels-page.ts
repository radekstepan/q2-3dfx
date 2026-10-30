// @q2/testkit — GPU-FOLLOW-3A sky pixel-probe page builder.
//
// Builds the HTML page the sky-pixels harness serves to real Chromium at
// runtime (never committed). The page imports the BUILT production dists
// (@q2/webgl-renderer, @q2/sw-renderer, @q2/bsp, @q2/formats, @q2/config)
// through an import map and renders through the PRODUCTION WebGLRenderer +
// production shaders, then publishes window.__q2proof with real-pixel
// captures (readPixels here is test-only capture; the normal production
// path stays readback-free, pinned by the gpu-readback scan).
//
// Legs (all rendered pixels, map/camera/FOV/cvars recorded in the proof):
//   S1 edge isolation (synthetic flat-color faces, yaw 45 edge-on, LINEAR)
//   S2 corner isolation (yaw 45 pitch -35, LINEAR)
//   S3 edge isolation with NEAREST (vd_bilinear 0)
//   S4 predicate liveness (CPU-blended copy must be flagged, exactly)
//   W1 zero-sky-ref background (empty selection still draws the box) +
//      cleared-strip control (must be clear-black)
//   R1 real base1 turned view (sky refs) strip vs cleared before/after
//   R2 real base1 window hunt: glass faceViews, strip vs cleared, best diff
//
// This module is a pure string builder (no DOM, no node:*): safe to import
// from the Node harness. NEVER import it from a browser bundle.

import type { GpuBrowserLibMap } from './gpu-browser-page.js';

/** Build the sky-probe test page HTML. */
export function buildSkyProbePageHtml(libMap: GpuBrowserLibMap): string {
  const importMap = JSON.stringify({ imports: libMap });
  return (
    '<!doctype html>\n' +
    '<html><head><meta charset="utf-8"><title>q2 sky probe</title>\n' +
    '<script type="importmap">' + importMap + '</' + 'script>\n' +
    '</head><body style="margin:0;background:#000">\n' +
    '<canvas id="c" width="320" height="240" style="width:320px;height:240px;margin:0;display:block"></canvas>\n' +
    '<script type="module">\n' +
    SKY_PROBE_JS +
    '\n</' + 'script>\n' +
    '</body></html>\n'
  );
}

const SKY_PROBE_JS = `
'use strict';
import { WebGLRenderer, selectGpuScene } from '@q2/webgl-renderer';
import { setCVar, resetCVars } from '@q2/config';
import { bspToMiniWorld } from '@q2/sw-renderer';
import { loadBsp } from '@q2/bsp';
import { parseWAL, parsePCX } from '@q2/formats';

var W = 320, H = 240, N = W * H;
var proof = { done: false, error: null };
window.__q2proof = proof;
window.addEventListener('error', function (e) {
  if (!proof.done) { proof.done = true; proof.error = 'window.onerror: ' + e.message; }
});

function f32(a) { return new Float32Array(a); }
function log(s) { try { console.log('[sky-probe] ' + s); } catch (e) {} }
function fetchBuf(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error('fetch ' + url + ': HTTP ' + r.status);
    return r.arrayBuffer();
  });
}

// Six flat face colors (primaries + secondaries: fixed points of the
// RGB565 + gamma-1.3 appearance chain, so any deviation is scene bleed).
var FACE_COLORS = [[255,0,0],[0,255,0],[0,0,255],[255,255,0],[255,0,255],[0,255,255]];

function makePalette() {
  var p = new Uint8Array(768);
  for (var f = 0; f < 6; f++) {
    p[(f + 1) * 3] = FACE_COLORS[f][0];
    p[(f + 1) * 3 + 1] = FACE_COLORS[f][1];
    p[(f + 1) * 3 + 2] = FACE_COLORS[f][2];
  }
  p[7 * 3] = 255; p[7 * 3 + 1] = 255; p[7 * 3 + 2] = 255;
  return p;
}

function makeFlatStrip(tile) {
  var px = new Uint8Array(tile * tile * 6);
  for (var f = 0; f < 6; f++) px.fill(f + 1, f * tile * tile, (f + 1) * tile * tile);
  return px;
}

// -1 when the pixel is not exactly one of the six face colors.
function exactFaceAt(px, o) {
  var r = px[o], g = px[o + 1], b = px[o + 2];
  for (var f = 0; f < 6; f++) {
    var c = FACE_COLORS[f];
    if (r === c[0] && g === c[1] && b === c[2]) return f;
  }
  return -1;
}

// Audit a full capture: every pixel must be exactly a face color.
function auditExact(px) {
  var bad = 0, black = 0, perFace = [0, 0, 0, 0, 0, 0], badIdx = [];
  for (var i = 0; i < N; i++) {
    var o = i * 4;
    var f = exactFaceAt(px, o);
    if (f < 0) {
      bad++;
      if (px[o] === 0 && px[o + 1] === 0 && px[o + 2] === 0) black++;
      if (badIdx.length < 16) badIdx.push(i);
    } else {
      perFace[f]++;
    }
  }
  return { bad: bad, black: black, perFace: perFace, badIdx: badIdx };
}

function countBlack(px) {
  var n = 0;
  for (var i = 0; i < N; i++) {
    var o = i * 4;
    if (px[o] === 0 && px[o + 1] === 0 && px[o + 2] === 0) n++;
  }
  return n;
}

function diffCount(a, b) {
  var n = 0;
  for (var i = 0; i < N; i++) {
    var o = i * 4;
    if (a[o] !== b[o] || a[o + 1] !== b[o + 1] || a[o + 2] !== b[o + 2]) n++;
  }
  return n;
}

// Non-black fraction among pixels where a and b differ (textured vs black).
function diffNonBlackFrac(a) {
  var nb = 0, n = 0;
  for (var i = 0; i < N; i++) {
    var o = i * 4;
    n++;
    if (a[o] !== 0 || a[o + 1] !== 0 || a[o + 2] !== 0) nb++;
  }
  return n === 0 ? 0 : nb / n;
}

function viewOf(origin, yaw, pitch, fovX) {
  return {
    origin: f32(origin),
    angles: f32([pitch, yaw, 0]),
    fovX: fovX,
    time: 1.5,
    lightStyles: new Float32Array(256).fill(1),
  };
}

async function main() {
  var canvas = document.getElementById('c');
  var rawGL = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: true, stencil: false });
  if (!rawGL) throw new Error('no webgl2 context (getContext returned null)');
  var version = String(rawGL.getParameter(rawGL.VERSION));
  proof.webgl2 = version.indexOf('WebGL 2.0') !== -1;
  proof.glVersion = version;
  proof.glRenderer = String(rawGL.getParameter(rawGL.RENDERER));
  if (!proof.webgl2) throw new Error('not WebGL2: ' + version);

  // --- synthetic legs: exact-passthrough appearance (bypass + gamma 1) ---
  resetCVars();
  setCVar('vd_16bit', 0);
  setCVar('vd_gamma', 1);
  setCVar('vd_dither', 0);
  setCVar('vd_postfilter', 0);
  setCVar('vd_bilinear', 1);
  setCVar('vd_fog', 0);

  var TILE = 32;
  var palette = makePalette();
  var strip = makeFlatStrip(TILE);
  var emptyWorld = { surfaces: [], textures: [], lightmaps: [], particles: [], leafs: [], nodes: [] };
  var emptyScene = { surfaces: [], transforms: [new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1])], staticGeneration: 1 };

  function renderView(r, view) {
    r.setEntities([], undefined);
    r.renderFrame({ view: view, scene: emptyScene, time: 1.5 });
    var px = new Uint8Array(N * 4);
    rawGL.readPixels(0, 0, W, H, rawGL.RGBA, rawGL.UNSIGNED_BYTE, px);
    return px;
  }

  var r = new WebGLRenderer();
  r.init(rawGL, W, H);
  r.attachWorld(emptyWorld);
  r.setPalette(palette);
  if (!r.registerSkyStrip(strip, TILE, TILE)) throw new Error('synthetic registerSkyStrip rejected');
  r.setScene(emptyScene);

  // Warmup past first-submit settle (SwiftShader LSB drift on first submit).
  var EDGE = viewOf([0, 0, 0], 45, 0, 90);
  renderView(r, EDGE);
  renderView(r, EDGE);

  var t0 = { cvars: { vd_16bit: 0, vd_gamma: 1, vd_dither: 0, vd_postfilter: 0, vd_bilinear: 1, vd_fog: 0 }, fovX: 90 };
  var pxEdge = renderView(r, EDGE);
  var s1 = auditExact(pxEdge);
  s1.centre = exactFaceAt(pxEdge, (((H >> 1) * W + (W >> 1)) * 4));
  proof.synth = { edge: s1 };
  log('S1 edge: ' + JSON.stringify(s1));

  var CORNER = viewOf([0, 0, 0], 45, -35.26, 90);
  var pxCorner = renderView(r, CORNER);
  var s2 = auditExact(pxCorner);
  proof.synth.corner = s2;
  log('S2 corner: ' + JSON.stringify(s2));

  setCVar('vd_bilinear', 0);
  var pxNear = renderView(r, EDGE);
  var s3 = auditExact(pxNear);
  proof.synth.nearest = s3;
  log('S3 nearest: ' + JSON.stringify(s3));
  setCVar('vd_bilinear', 1);

  // S4 predicate liveness: blend 8 known pixels on the CPU; the same audit
  // must flag exactly those 8 (proves the exactness check can fail).
  var pxTampered = pxEdge.slice();
  var tamperIdx = [];
  for (var ti = 0; ti < 8; ti++) {
    var pi = 1000 + ti * 977;
    tamperIdx.push(pi);
    var o = pi * 4;
    pxTampered[o] = (pxTampered[o] + 127) & 255;
    pxTampered[o + 1] = (pxTampered[o + 1] + 127) & 255;
  }
  var s4 = auditExact(pxTampered);
  proof.synth.tamper = { bad: s4.bad, want: tamperIdx.length, match: JSON.stringify(s4.badIdx.slice(0, 8)) === JSON.stringify(tamperIdx.slice(0, 8)) };
  log('S4 tamper: ' + JSON.stringify(proof.synth.tamper));

  // W1: empty selection (zero sky refs) still gets the textured background.
  var pxWin = renderView(r, viewOf([0, 0, 0], 0, 0, 90));
  var w1 = auditExact(pxWin);
  w1.blackFrac = countBlack(pxWin) / N;
  w1.lastSky = r.testLastSky();
  proof.window = w1;
  log('W1 window: ' + JSON.stringify(w1));
  r.clearSkyStrip();
  var pxCleared = renderView(r, viewOf([0, 0, 0], 0, 0, 90));
  proof.windowCleared = { blackFrac: countBlack(pxCleared) / N, diffVsTextured: diffCount(pxWin, pxCleared) / N, lastSky: r.testLastSky() };
  log('W1 cleared: ' + JSON.stringify(proof.windowCleared));

  // --- real-map legs (production appearance defaults) ---
  proof.real = null;
  try {
    var map = loadBsp(await fetchBuf('/assets/maps/base1.bsp'));
    var names = {};
    for (var ti = 0; ti < map.texinfoNames.length; ti++) names[map.texinfoNames[ti]] = true;
    var walNames = Object.keys(names);
    var walBufs = await Promise.all(walNames.map(function (n) {
      return fetchBuf('/assets/textures/' + n + '.wal').then(function (b) { return b; }, function () { return null; });
    }));
    var walStore = {};
    for (var wi = 0; wi < walNames.length; wi++) walStore[walNames[wi]] = walBufs[wi];
    var world = bspToMiniWorld(map, { texelFor: function (walName) {
      var buf = walStore[walName];
      if (!buf) return null;
      try {
        var wal = parseWAL(buf);
        return { texels: wal.mips[0], width: wal.width, height: wal.height };
      } catch (e) { return null; }
    }});
    world.particles = [];
    var realPalette = parsePCX(await fetchBuf('/assets/pics/colormap.pcx')).palette;
    var SUFS = ['rt', 'bk', 'lf', 'ft', 'up', 'dn'];
    var faces = [];
    for (var fi = 0; fi < 6; fi++) {
      faces.push(parsePCX(await fetchBuf('/assets/env/unit1_' + SUFS[fi] + '.pcx')));
    }
    var tileW = faces[0].width, tileH = faces[0].height;
    var realStrip = new Uint8Array(tileW * tileH * 6);
    for (var fj = 0; fj < 6; fj++) realStrip.set(faces[fj].pixels, fj * tileW * tileH);
    log('real assets ok: surfaces=' + world.surfaces.length + ' skyTile=' + tileW + 'x' + tileH);

    resetCVars();
    var rr = new WebGLRenderer();
    rr.init(rawGL, W, H);
    rr.attachWorld(world);
    rr.setPalette(realPalette);
    if (!rr.registerSkyStrip(realStrip, tileW, tileH)) throw new Error('real registerSkyStrip rejected');

    function renderReal(view) {
      var scene = selectGpuScene(world, [], view, W, H);
      rr.setScene(scene);
      rr.setEntities([], undefined);
      rr.renderFrame({ view: view, scene: scene, time: 1.5 });
      var px = new Uint8Array(N * 4);
      rawGL.readPixels(0, 0, W, H, rawGL.RGBA, rawGL.UNSIGNED_BYTE, px);
      var skyRefs = 0;
      for (var si = 0; si < scene.surfaces.length; si++) {
        if (scene.surfaces[si].material === 'sky') skyRefs++;
      }
      return { px: px, skyRefs: skyRefs, lastSky: rr.testLastSky() };
    }

    var TURN = viewOf([128, -320, 54], 270, 0, 90);
    renderReal(TURN);
    var t1 = renderReal(TURN);
    rr.clearSkyStrip();
    var t1c = renderReal(TURN);
    var d1 = diffCount(t1.px, t1c.px) / N;
    var nb1 = 0;
    for (var d = 0; d < N; d++) {
      var oo = d * 4;
      if (t1.px[oo] !== t1c.px[oo] || t1.px[oo + 1] !== t1c.px[oo + 1] || t1.px[oo + 2] !== t1c.px[oo + 2]) {
        if (t1.px[oo] !== 0 || t1.px[oo + 1] !== 0 || t1.px[oo + 2] !== 0) nb1++;
      }
    }
    // Replay stability: re-registering the same strip after a clear renders
    // byte-identical to the pre-clear capture (cold-boot/switch/restore
    // replay is pixel-stable on real art).
    rr.registerSkyStrip(realStrip, tileW, tileH);
    renderReal(TURN);
    var t1e = renderReal(TURN);
    var replayDiff = diffCount(t1.px, t1e.px);
    proof.real = {
      turned: { skyRefs: t1.skyRefs, lastSky: t1.lastSky, diffVsCleared: d1, diffNonBlack: nb1 / N, replayDiff: replayDiff, cvars: 'defaults', fovX: 90, origin: [128, -320, 54], yaw: 270, pitch: 0 },
    };
    log('R1 turned: ' + JSON.stringify(proof.real.turned));

    // R2 window hunt: explicit spawn views plus glass faceViews near spawn.
    // Tracks the max-diff view overall AND the max-diff view with zero
    // selected sky refs (the through-window shape: no hull sky in the
    // selection, background still textured).
    var cands = [{ origin: [128, -320, 54], yaw: 90, pitch: 0, id: -1, label: 'F0-spawn-north' }];
    for (var gi = 0; gi < world.surfaces.length && cands.length < 13; gi++) {
      var s = world.surfaces[gi];
      if (!s || s.n < 3 || s.sky || s.turbulent || !(s.translucent === 1 || s.translucent === 2)) continue;
      var dx = s.center[0] - 128, dy = s.center[1] + 320, dz = s.center[2] - 54;
      if (dx * dx + dy * dy + dz * dz > 1200 * 1200) continue;
      var ox = s.center[0] + s.fn[0] * 80;
      var oy = s.center[1] + s.fn[1] * 80;
      var oz = s.center[2] + s.fn[2] * 80 + 8;
      var vx = s.center[0] - ox, vy = s.center[1] - oy, vz = s.center[2] - oz;
      var len = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
      var yaw = Math.atan2(vy, vx) * 180 / Math.PI;
      var pitch = -Math.asin(vz / len) * 180 / Math.PI;
      cands.push({ origin: [ox, oy, oz], yaw: yaw, pitch: pitch, id: s.id });
    }
    log('R2 candidates: ' + cands.length);
    var best = null, bestZero = null;
    for (var ci = 0; ci < cands.length; ci++) {
      var cv = viewOf(cands[ci].origin, cands[ci].yaw, cands[ci].pitch, 90);
      var a = renderReal(cv);
      rr.clearSkyStrip();
      var b = renderReal(cv);
      rr.registerSkyStrip(realStrip, tileW, tileH);
      var dd = diffCount(a.px, b.px) / N;
      var anb = 0;
      for (var q = 0; q < N; q++) {
        var qo = q * 4;
        if (a.px[qo] !== b.px[qo] || a.px[qo + 1] !== b.px[qo + 1] || a.px[qo + 2] !== b.px[qo + 2]) {
          if (a.px[qo] !== 0 || a.px[qo + 1] !== 0 || a.px[qo + 2] !== 0) anb++;
        }
      }
      var rec = { id: cands[ci].id, label: cands[ci].label || 'glass', skyRefs: a.skyRefs, diff: dd, diffNonBlack: anb / N, lastSky: a.lastSky, origin: cands[ci].origin, yaw: cands[ci].yaw, pitch: cands[ci].pitch };
      if (!best || rec.diff > best.diff) best = rec;
      if (a.skyRefs === 0 && (!bestZero || rec.diff > bestZero.diff)) bestZero = rec;
    }
    proof.real.windowBest = best;
    proof.real.windowBestZero = bestZero;
    proof.real.windowTried = cands.length;
    log('R2 best: ' + JSON.stringify(best));
    log('R2 bestZero: ' + JSON.stringify(bestZero));
  } catch (e) {
    proof.realError = String((e && e.message) || e).slice(0, 300);
    log('real legs skipped/failed: ' + proof.realError);
  }

  proof.done = true;
}

main().then(
  function () { if (!proof.done) { proof.done = true; } },
  function (e) { proof.done = true; proof.error = String((e && e.message) || e).slice(0, 500); }
);
`;
