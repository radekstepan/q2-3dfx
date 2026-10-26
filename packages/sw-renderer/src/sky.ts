// @q2/sw-renderer sky — ref_soft skybox port (r_rast.c R_InitSkyBox /
// R_EmitSkyBox, r_main.c R_SetSky, r_edge.c D_SkySurf).
//
// What id actually does (read, not guessed):
// - Map `SURF_SKY` surfaces are NEVER rasterised. When one is encountered,
//   R_EmitSkyBox() emits 6 axis-aligned box faces at +/-128 around the view
//   origin instead, textured with `env/<skyname><suffix>.pcx` (suffixes
//   rt/bk/lf/ft/up/dn, face->suffix via r_skysideimage = {5,2,4,1,0,3}).
// - D_SkySurf draws each box face as a normal textured span fill (mip 0,
//   cachewidth 256, NO lightmap — fullbright) and writes depth at infinity.
// - ref_soft has NO time scroll: R_SetSky stores skyrotate/skyaxis but
//   nothing in ref_soft ever reads them (only ref_gl/gl_warp.c rotates the
//   sky). The Q2 software sky is static relative to the view direction.
//   (Quake 1's scrolling r_sky.c clouds do not exist in Q2.)
//
// Our pipeline mirrors that structure (frame.ts emitSkyBox): when a SURF_SKY
// surface is visible, the 6 box faces at SKY_BOX_HALF around the camera
// origin are rasterised instead of the world poly — one single-face quad per
// box face, so span interpolation of (u,v) can never sweep across tile
// boundaries. Each face carries its own tile's UVs from the same
// view-locked box mapping; the box sits far beyond any real geometry, so
// it depth-tests as background with exact perspective math.
//
// PACKING CONTRACT for setSkyTexture (the renderer never touches the pak;
// a parallel agent wires the web side — do not deviate):
// - ONE texture: a VERTICAL STRIP of 6 tiles, stacked top-to-bottom in
//   FILENAME SUFFIX order: [rt, bk, lf, ft, up, dn].
//   Tile f occupies rows [f*tileH, (f+1)*tileH), full strip width.
// - tex.width = tileW (ONE tile wide; MUST be a power of two: the affine
//   sampler indexes with (u & (tileW-1)), e.g. 256 for real data).
// - tex.height = 6 * tileH (tileH = height/6, any positive integer;
//   256 for real data, which are all 256x256 PCX). Non-multiple heights
//   and non-POT widths are rejected (flat-fill fallback, never a crash).
// - Renderer maps id box face -> tile with id's own table SKY_SIDE_IMAGE
//   (r_skysideimage): face 0 (down) -> tile 5 (dn), 1 (x-) -> tile 2 (lf),
//   2 (up) -> tile 4 (up), 3 (y+) -> tile 1 (bk), 4 (x+) -> tile 0 (rt),
//   5 (y-) -> tile 3 (ft). All 8-bit palette indices, top row = v 0.

/** Tile order in the packed strip, id `suf` in R_SetSky (r_main.c). */
export const SKY_TILE_SUFFIXES = ['rt', 'bk', 'lf', 'ft', 'up', 'dn'] as const;

/** id `r_skysideimage` (r_main.c): box face -> suffix index. */
export const SKY_SIDE_IMAGE = [5, 2, 4, 1, 0, 3] as const;

/**
 * Box-face texture axes, id `box_vecs` (r_rast.c), indexed by face:
 * [sAxis(3), tAxis(3)]. The face itself is implied by the dominant axis
 * (see skyFaceForDir): 0 = z-, 1 = x-, 2 = z+, 3 = y+, 4 = x+, 5 = y-,
 * matching id `skybox_planes`.
 */
const SKY_FACE_AXES: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [0, -1, 0, -1, 0, 0], // 0 bottom (dn): s=-Y, t=-X
  [0, 1, 0, 0, 0, -1],  // 1 x- (lf):     s=+Y, t=-Z
  [0, -1, 0, 1, 0, 0],  // 2 top (up):    s=-Y, t=+X
  [1, 0, 0, 0, 0, -1],  // 3 y+ (bk):     s=+X, t=-Z
  [0, -1, 0, 0, 0, -1], // 4 x+ (rt):     s=-Y, t=-Z
  [-1, 0, 0, 0, 0, -1], // 5 y- (ft):     s=-X, t=-Z
];

/**
 * Box face pierced by direction d (world space, camera at the origin).
 * Port of the id mapping: dominant axis picks the face, its sign the side.
 * Ties resolve z > x > y; the zero vector maps to face 4 (rt, +X).
 */
export function skyFaceForDir(dx: number, dy: number, dz: number): number {
  const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
  if (az >= ax && az >= ay) return dz >= 0 ? 2 : 0;
  if (ax >= ay) return dx >= 0 ? 4 : 1;
  return dy >= 0 ? 3 : 5;
}

/**
 * Skybox (u, v) in packed-strip texel units for direction d.
 * u in [0, tileW), v = tile*tileH + [0, tileH) with
 * tile = SKY_SIDE_IMAGE[face]. Clamped inside the tile so rounding can
 * never bleed into a neighbour tile. `out` receives [u, v].
 */
export function skyUvForDir(
  dx: number, dy: number, dz: number,
  tileW: number, tileH: number,
  out: { u: number; v: number },
): { u: number; v: number } {
  const face = skyFaceForDir(dx, dy, dz);
  const axes = SKY_FACE_AXES[face]!;
  const dom = Math.abs(face === 0 || face === 2 ? dz : face === 1 || face === 4 ? dx : dy);
  if (!(dom > 1e-9)) {
    // Vertex exactly at the camera: sample tile centre of face 4 (rt).
    out.u = tileW / 2;
    out.v = SKY_SIDE_IMAGE[4]! * tileH + tileH / 2;
    return out;
  }
  const inv = 1 / dom;
  const su = (dx * axes[0]! + dy * axes[1]! + dz * axes[2]!) * inv;
  const tv = (dx * axes[3]! + dy * axes[4]! + dz * axes[5]!) * inv;
  const eps = 1 / 256;
  const cu = su * 0.5 + 0.5;
  const cv = tv * 0.5 + 0.5;
  out.u = Math.min(Math.max(cu * tileW, 0), tileW - eps);
  const lv = Math.min(Math.max(cv * tileH, 0), tileH - eps);
  out.v = SKY_SIDE_IMAGE[face]! * tileH + lv;
  return out;
}

/**
 * Skybox (u, v) for direction d forced onto box face `face` (no per-vertex
 * face selection). Used to rasterise one world-sky fragment with a single
 * tile so span interpolation can never sweep across tile boundaries (the
 * black-lava streak: bk/lf black bands dragged over orange faces). Same
 * box_vecs projection as skyUvForDir, tile from SKY_SIDE_IMAGE[face].
 */
export function skyUvOnFace(
  dx: number, dy: number, dz: number,
  face: number,
  tileW: number, tileH: number,
  out: { u: number; v: number },
): { u: number; v: number } {
  const axes = SKY_FACE_AXES[face]!;
  const dom = Math.abs(face === 0 || face === 2 ? dz : face === 1 || face === 4 ? dx : dy);
  if (!(dom > 1e-9)) {
    out.u = tileW / 2;
    out.v = SKY_SIDE_IMAGE[face]! * tileH + tileH / 2;
    return out;
  }
  const inv = 1 / dom;
  const su = (dx * axes[0]! + dy * axes[1]! + dz * axes[2]!) * inv;
  const tv = (dx * axes[3]! + dy * axes[4]! + dz * axes[5]!) * inv;
  const eps = 1 / 256;
  const cu = su * 0.5 + 0.5;
  const cv = tv * 0.5 + 0.5;
  out.u = Math.min(Math.max(cu * tileW, 0), tileW - eps);
  const lv = Math.min(Math.max(cv * tileH, 0), tileH - eps);
  out.v = SKY_SIDE_IMAGE[face]! * tileH + lv;
  return out;
}

/**
 * View-centered skybox half-size (id R_EmitSkyBox uses +/-128 around the
 * view origin; ours sits far enough that every real surface depth-tests in
 * front of it, so the box reads as infinity without an explicit depth
 * override — the perspective span math stays exact, no fixed-point hazard).
 * Quake II maps span a few thousand units; 16384 keeps 1/z well above the
 * cleared depth plane while staying float-precise through projection.
 */
export const SKY_BOX_HALF = 16384;

/**
 * Camera-relative box corners per face (cyclic quads), id `box_verts`
 * regrouped by face. Any cyclic order works (no culling on sky polys).
 * Face order: 0 dn(-Z), 1 lf(-X), 2 up(+Z), 3 bk(+Y), 4 rt(+X), 5 ft(-Y).
 */
export const SKY_BOX_CORNERS: ReadonlyArray<readonly [number, number, number, number, number, number, number, number, number, number, number, number]> = [
  [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1], // 0 dn
  [-1, 1, -1, -1, -1, -1, -1, -1, 1, -1, 1, 1], // 1 lf
  [-1, -1, 1, -1, 1, 1, 1, 1, 1, 1, -1, 1], // 2 up
  [1, 1, -1, -1, 1, -1, -1, 1, 1, 1, 1, 1], // 3 bk
  [1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1], // 4 rt
  [-1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1], // 5 ft
];

/**
 * Fill `out` (2*n floats) with packed-strip UVs for n world vertices
 * relative to the camera origin. Scratch for the frame sky path.
 */
export function computeSkyUvs(
  verts: Float32Array, n: number,
  ox: number, oy: number, oz: number,
  tileW: number, tileH: number,
  out: Float32Array,
): void {
  const tmp = { u: 0, v: 0 };
  for (let i = 0; i < n; i++) {
    skyUvForDir(
      verts[i * 3]! - ox, verts[i * 3 + 1]! - oy, verts[i * 3 + 2]! - oz,
      tileW, tileH, tmp,
    );
    out[i * 2] = tmp.u;
    out[i * 2 + 1] = tmp.v;
  }
}

/**
 * Validate a packed sky strip for the affine sampler: POT width (mask
 * indexing), height an exact multiple of 6 (one tile per suffix).
 */
export function isValidSkySize(width: number, height: number): boolean {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return false;
  if (width < 1 || width > 1024) return false;
  if ((width & (width - 1)) !== 0) return false;
  if (height < 6 || height > 6144) return false;
  return height % 6 === 0;
}
