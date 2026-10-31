// @q2/testkit — GPU-FOLLOW-3B water pixel-probe page builder.
//
// Builds the HTML page the water-pixels harness serves to real Chromium at
// runtime (never committed). The page imports the BUILT production dists
// (@q2/webgl-renderer, @q2/sw-renderer, @q2/bsp, @q2/formats, @q2/config)
// through an import map and renders through the PRODUCTION WebGLRenderer +
// production shaders (FS_LIT with the LOD-unwarped + highp repair), then
// reads back actual pixels (test-only capture; the normal production path
// stays readback-free, pinned by the gpu-readback scan).
//
// Legs (all rendered pixels; map/camera/material/time recorded in the proof):
//   S-det  synthetic turbulent+translucent quad pair, same time twice: exact
//   S-anim synthetic t=0 vs t=7.25: warped water actually moves pixels
//   S-wrap synthetic phase wrap t=15.984375 vs t=16.0: continuity bound
//   S-neg  synthetic same camera with the water world detached: the water
//          pixels must come from the geometry (clear-color control)
//   R-det  real base1 pool view, same time twice: byte-identical replay
//   R-anim real t=0 vs t=7.25 (+t=1.5): motion alive on retail art
//   R-wrap real phase wrap 1023->0: bounded change, far below motion
//   R-neg  real same view with the bluwter WAL withheld (required asset
//          removed): the water region must change substantially; the
//          textured-vs-stripped bbox IS the water region, and the motion
//          bbox must overlap it (motion is water, not elsewhere)
//
// This module is a pure string builder (no DOM, no node:*): safe to import
// from the Node harness. NEVER import it from a browser bundle.

import type { GpuBrowserLibMap } from './gpu-browser-page.js';

/** Build the water-probe test page HTML. */
export function buildWaterProbePageHtml(libMap: GpuBrowserLibMap): string {
  const importMap = JSON.stringify({ imports: libMap });
  return (
    '<!doctype html>\n' +
    '<html><head><meta charset="utf-8"><title>q2 water probe</title>\n' +
    '<script type="importmap">' + importMap + '</' + 'script>\n' +
    '</head><body style="margin:0;background:#000">\n' +
    '<canvas id="c" width="320" height="240" style="width:320px;height:240px;margin:0;display:block"></canvas>\n' +
    '<script type="module">\n' +
    WATER_PROBE_JS +
    '\n</' + 'script>\n' +
    '</body></html>\n'
  );
}

const WATER_PROBE_JS = `
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
function log(s) { try { console.log('[water-probe] ' + s); } catch (e) {} }
function fetchBuf(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error('fetch ' + url + ': HTTP ' + r.status);
    return r.arrayBuffer();
  });
}

function viewOf(origin, yaw, pitch, fovX, time) {
  return {
    origin: f32(origin),
    angles: f32([pitch, yaw, 0]),
    fovX: fovX,
    time: time,
    lightStyles: new Float32Array(256).fill(1),
  };
}

function diffStats(a, b) {
  var count = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (var i = 0; i < N; i++) {
    var o = i * 4;
    if (a[o] !== b[o] || a[o + 1] !== b[o + 1] || a[o + 2] !== b[o + 2]) {
      count++;
      var x = i % W, y = (i / W) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (count === 0) return { count: 0, frac: 0, bbox: null, bboxArea: 0 };
  return { count: count, frac: count / N, bbox: [x0, y0, x1, y1], bboxArea: (x1 - x0 + 1) * (y1 - y0 + 1) };
}

function bboxOverlapArea(a, b) {
  if (!a || !b) return 0;
  var x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
  var x1 = Math.min(a[2], b[2]), y1 = Math.min(a[3], b[3]);
  if (x1 < x0 || y1 < y0) return 0;
  return (x1 - x0 + 1) * (y1 - y0 + 1);
}

function countNonBlack(px) {
  var n = 0;
  for (var i = 0; i < N; i++) {
    var o = i * 4;
    if (px[o] !== 0 || px[o + 1] !== 0 || px[o + 2] !== 0) n++;
  }
  return n;
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

  // Production appearance defaults (the shipped water path, not a diagnostic
  // bypass: warp + mipmaps + blending stay on).
  resetCVars();

  // --- synthetic legs: hand-built turbulent+translucent quad pair -----------
  // Two 8x8 quads sharing the x=8 edge with one continuous texel mapping
  // (mirrors real base1 faces 117/118: same texId, same uv at shared verts;
  // TRANS66 blend alpha). Tileable 4-texel-block art so warp motion moves
  // block edges across pixels.
  var palette = new Uint8Array(768);
  palette[3] = 200; palette[4] = 30; palette[5] = 30;     // 1 red
  palette[6] = 30; palette[7] = 200; palette[8] = 30;      // 2 green
  palette[9] = 30; palette[10] = 30; palette[11] = 200;    // 3 blue
  palette[12] = 220; palette[13] = 220; palette[14] = 220;  // 4 white
  var synTex = new Uint8Array(64 * 64);
  for (var sy = 0; sy < 64; sy++) {
    for (var sx = 0; sx < 64; sx++) {
      synTex[sy * 64 + sx] = 1 + (((sx >> 2) ^ (sy >> 2)) & 3);
    }
  }
  function synQuad(id, x0, lightId) {
    return {
      id: id,
      verts: f32([x0, 0, 0, x0 + 8, 0, 0, x0 + 8, 0, 8, x0, 0, 8]),
      uvs: f32([x0, 0, x0 + 8, 0, x0 + 8, 8, x0, 8]),
      lux: f32([0, 0, 1, 0, 1, 1, 0, 1]),
      n: 4,
      texId: 0,
      lightId: lightId,
      center: f32([x0 + 4, 0, 4]),
      radius: 8,
      mins: f32([x0, -1, -1]),
      maxs: f32([x0 + 8, 1, 9]),
      turbulent: true,
      translucent: 2,
      sky: false,
      fn: f32([0, 1, 0]),
    };
  }
  var synWorld = {
    brand: 'miniworld',
    nodes: [], leafs: [{ cluster: 0, firstSurf: 0, numSurfs: 2 }], pvs: [], clusterCount: 0,
    surfaces: [synQuad(0, 0, 0), synQuad(1, 8, 1)],
    textures: [{ texels: synTex, width: 64, height: 64 }],
    lightmaps: [
      { samples: new Uint8Array(12).fill(64), luxW: 2, luxH: 2, styles: [0, 255, 255, 255] },
      { samples: new Uint8Array(12).fill(64), luxW: 2, luxH: 2, styles: [0, 255, 255, 255] },
    ],
    dynamicLights: [], alias: [], sprites: [], particles: [],
  };
  var synEmpty = {
    brand: 'miniworld',
    nodes: [], leafs: [], pvs: [], clusterCount: 0,
    surfaces: [], textures: [], lightmaps: [],
    dynamicLights: [], alias: [], sprites: [], particles: [],
  };
  var SYN_VIEW = { origin: [8, -24, 4], yaw: 90, pitch: 8 };

  function renderWith(r, world, origin, yaw, pitch, time) {
    var scene = selectGpuScene(world, [], viewOf(origin, yaw, pitch, 90, time), W, H);
    r.setScene(scene);
    r.setEntities([], undefined);
    r.renderFrame({ view: viewOf(origin, yaw, pitch, 90, time), scene: scene, time: time });
    var px = new Uint8Array(N * 4);
    rawGL.readPixels(0, 0, W, H, rawGL.RGBA, rawGL.UNSIGNED_BYTE, px);
    var turb = 0;
    for (var i = 0; i < scene.surfaces.length; i++) {
      if (scene.surfaces[i].material === 'turbulent') turb++;
    }
    return { px: px, turbSelected: turb, sceneSurfaces: scene.surfaces.length };
  }

  var rs = new WebGLRenderer();
  rs.init(rawGL, W, H);
  rs.attachWorld(synWorld);
  rs.setPalette(palette);
  renderWith(rs, synWorld, SYN_VIEW.origin, SYN_VIEW.yaw, SYN_VIEW.pitch, 7.25);
  renderWith(rs, synWorld, SYN_VIEW.origin, SYN_VIEW.yaw, SYN_VIEW.pitch, 7.25);
  var sA = renderWith(rs, synWorld, SYN_VIEW.origin, SYN_VIEW.yaw, SYN_VIEW.pitch, 7.25);
  var sB = renderWith(rs, synWorld, SYN_VIEW.origin, SYN_VIEW.yaw, SYN_VIEW.pitch, 7.25);
  var s0 = renderWith(rs, synWorld, SYN_VIEW.origin, SYN_VIEW.yaw, SYN_VIEW.pitch, 0);
  var sW1 = renderWith(rs, synWorld, SYN_VIEW.origin, SYN_VIEW.yaw, SYN_VIEW.pitch, 15.984375);
  var sW2 = renderWith(rs, synWorld, SYN_VIEW.origin, SYN_VIEW.yaw, SYN_VIEW.pitch, 16.0);
  var rsEmpty = new WebGLRenderer();
  rsEmpty.init(rawGL, W, H);
  rsEmpty.attachWorld(synEmpty);
  rsEmpty.setPalette(palette);
  var sE = renderWith(rsEmpty, synEmpty, SYN_VIEW.origin, SYN_VIEW.yaw, SYN_VIEW.pitch, 7.25);
  proof.synth = {
    turbSelected: sA.turbSelected,
    sceneSurfaces: sA.sceneSurfaces,
    nonBlack: countNonBlack(sA.px) / N,
    det: diffStats(sA.px, sB.px),
    anim: diffStats(s0.px, sA.px),
    wrap: diffStats(sW1.px, sW2.px),
    emptyVsTextured: diffStats(sE.px, sA.px),
    overlapAnimWater: null,
  };
  var sAnim = proof.synth.anim, sEmpty = proof.synth.emptyVsTextured;
  proof.synth.overlapAnimWater = sAnim.bbox && sEmpty.bbox ? bboxOverlapArea(sAnim.bbox, sEmpty.bbox) / N : 0;
  log('synth: ' + JSON.stringify(proof.synth));

  // --- real-map legs (production defaults, retail art) ---------------------
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
    function texelForFull(walName) {
      var buf = walStore[walName];
      if (!buf) return null;
      try {
        var wal = parseWAL(buf);
        return { texels: wal.mips[0], width: wal.width, height: wal.height };
      } catch (e) { return null; }
    }
    // Negative control: the required bluwter asset is withheld (missing
    // texture fallback), everything else identical.
    function texelForDry(walName) {
      if (String(walName).toLowerCase() === 'e1u1/bluwter') return null;
      return texelForFull(walName);
    }
    var world = bspToMiniWorld(map, { texelFor: texelForFull });
    world.particles = [];
    var worldDry = bspToMiniWorld(map, { texelFor: texelForDry });
    worldDry.particles = [];
    var realPalette = parsePCX(await fetchBuf('/assets/pics/colormap.pcx')).palette;

    var ORIGIN = [416, 900, -100], YAW = 90, PITCH = 30;
    var rr = new WebGLRenderer();
    rr.init(rawGL, W, H);
    rr.attachWorld(world);
    rr.setPalette(realPalette);
    renderWith(rr, world, ORIGIN, YAW, PITCH, 7.25);
    renderWith(rr, world, ORIGIN, YAW, PITCH, 7.25);
    var rA = renderWith(rr, world, ORIGIN, YAW, PITCH, 7.25);
    var rB = renderWith(rr, world, ORIGIN, YAW, PITCH, 7.25);
    var r0 = renderWith(rr, world, ORIGIN, YAW, PITCH, 0);
    var r15 = renderWith(rr, world, ORIGIN, YAW, PITCH, 1.5);
    var rW1 = renderWith(rr, world, ORIGIN, YAW, PITCH, 15.984375);
    var rW2 = renderWith(rr, world, ORIGIN, YAW, PITCH, 16.0);
    var rrDry = new WebGLRenderer();
    rrDry.init(rawGL, W, H);
    rrDry.attachWorld(worldDry);
    rrDry.setPalette(realPalette);
    renderWith(rrDry, worldDry, ORIGIN, YAW, PITCH, 7.25);
    var rD = renderWith(rrDry, worldDry, ORIGIN, YAW, PITCH, 7.25);

    var det = diffStats(rA.px, rB.px);
    var anim = diffStats(r0.px, rA.px);
    var anim15 = diffStats(r15.px, rA.px);
    var wrap = diffStats(rW1.px, rW2.px);
    var dry = diffStats(rD.px, rA.px);
    proof.real = {
      map: 'base1',
      material: 'textures/e1u1/bluwter.wal 64x64 TRANS66',
      origin: ORIGIN, yaw: YAW, pitch: PITCH, fovX: 90,
      times: [0, 1.5, 7.25, 15.984375, 16.0],
      turbSelected: rA.turbSelected,
      sceneSurfaces: rA.sceneSurfaces,
      nonBlack: countNonBlack(rA.px) / N,
      det: det,
      anim: anim,
      anim15: anim15,
      wrap: wrap,
      dryVsWet: dry,
      overlapAnimWater: dry.bbox && anim.bbox ? bboxOverlapArea(dry.bbox, anim.bbox) / N : 0,
      overlapWrapWater: dry.bbox && wrap.bbox ? bboxOverlapArea(dry.bbox, wrap.bbox) / N : 0,
    };
    log('real: ' + JSON.stringify(proof.real));
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
