// @q2/bsp — bsp38.ts — BSP38 (IBSP version 38) loader, BSP-side.
//
// M2.1 owns this file. The cross-package contract in BRAIN.md §6 pins
// `@q2/formats` Bsp38 to {planes, nodes, leafs, faces, raw}; that stub is
// owned by another agent, so the full 19-lump world is defined HERE as
// BspMap, which structurally extends the formats Bsp38 (same field names
// and types for planes/nodes/leafs/faces/raw) plus the remaining lumps.
// Requested contract change (see report): extend formats Bsp38 with the
// extra lump arrays defined here once the formats owner picks them up.
//
// Layout (qcommon/qfiles.h QBSP lump order, dheader_t + d*_t structs):
//   planes     dplane_t    20B  normal[3]f + dist f + type i
//   vertexes   dvertex_t   12B  point[3]f
//   nodes      dnode_t     28B  planenum i + children[2]i + mins[3]s + maxs[3]s + firstface H + numfaces H
//   texinfo    texinfo_t   76B  vecs[2][4]f + flags i + value i + texture[32] + nexttexinfo i
//   faces      dface_t     20B  planenum H + side h + firstedge i + numedges h + texinfo h + styles[4]B + lightofs i
//   leafs      dleaf_t     28B  contents i + cluster h + area h + mins[3]h + maxs[3]h + firstleafface H + numleaffaces H + firstleafbrush H + numleafbrushes H
//   edges      dedge_t      4B  v[2]H
//   surfedges  int32        4B
//   models     dmodel_t    48B  mins[3]f + maxs[3]f + origin[3]f + headnode i + firstface i + numfaces i
//   brushes    dbrush_t    12B  firstside i + numsides i + contents i
//   brushsides dbrushside_t 4B  planenum H + texinfo h
//   areas      darea_t      8B  numareaportals i + firstareaportal i
//   areaportals dareaportal_t 8B portalnum i + otherarea i
//   visibility dvis_t header: numclusters i + bitofs[numclusters][2]i, then RLE bytes
//   lighting/entities/pop: raw bytes (entities decoded to string)
//
// Every lump is a flat typed array (or plain string for entities) — never
// arrays of objects — per BRAIN.md §8.
import { Com_Error } from '@q2/config';
import type { Bsp38 } from '@q2/formats';

export const BSP_IDENT = 0x50534249; // little-endian "IBSP"
export const BSP_VERSION = 38;

export const LUMP_ENTITIES = 0;
export const LUMP_PLANES = 1;
export const LUMP_VERTEXES = 2;
export const LUMP_VISIBILITY = 3;
export const LUMP_NODES = 4;
export const LUMP_TEXINFO = 5;
export const LUMP_FACES = 6;
export const LUMP_LIGHTING = 7;
export const LUMP_LEAFS = 8;
export const LUMP_LEAFFACES = 9;
export const LUMP_LEAFBRUSHES = 10;
export const LUMP_EDGES = 11;
export const LUMP_SURFEDGES = 12;
export const LUMP_MODELS = 13;
export const LUMP_BRUSHES = 14;
export const LUMP_BRUSHSIDES = 15;
export const LUMP_POP = 16;
export const LUMP_AREAS = 17;
export const LUMP_AREAPORTALS = 18;
export const HEADER_LUMPS = 19;

// Flat strides for the packed Int32Array lumps.
export const NODE_STRIDE = 11; // planenum, c0, c1, mins[3], maxs[3], firstface, numfaces
export const LEAF_STRIDE = 13; // contents, cluster, area, mins[3], maxs[3], firstleafface, numleaffaces, firstleafbrush, numleafbrushes
export const FACE_STRIDE = 10; // planenum, side, firstedge, numedges, texinfo, style[4], lightofs
export const BRUSH_STRIDE = 3; // firstside, numsides, contents
export const BRUSHSIDE_STRIDE = 2; // planenum, texinfo
export const MODEL_EXTRA_STRIDE = 3; // headnode, firstface, numfaces
export const AREA_STRIDE = 2; // numareaportals, firstareaportal
export const AREAPORTAL_STRIDE = 2; // portalnum, otherarea

/** Full BSP38 world. Extends the formats stub Bsp38 with identical field types. */
export interface BspMap extends Bsp38 {
  /** n*4 floats: normal xyz + dist per plane. */
  planes: Float32Array;
  /** n plane type ints (PLANE_X..PLANE_ANYZ). */
  planeTypes: Int32Array;
  /** n*3 vertex positions. */
  vertexes: Float32Array;
  /** Raw visibility lump bytes (RLE). */
  visibility: Uint8Array;
  /** Number of clusters (from dvis_t header; 0 when lump empty). */
  numClusters: number;
  /** numClusters*2 ints: [pvsOfs, phsOfs] per cluster. */
  visBitofs: Int32Array;
  /** Packed nodes, NODE_STRIDE ints each. */
  nodes: Int32Array;
  /** n*3 node bounds mins (int16 values widened). */
  nodeMins: Int16Array;
  /** n*3 node bounds maxs. */
  nodeMaxs: Int16Array;
  /** n*8 texinfo s/t vectors (vecs[2][4]). */
  texinfoVecs: Float32Array;
  /** n texinfo flags / value / nexttexinfo. */
  texinfoFlags: Int32Array;
  texinfoValue: Int32Array;
  texinfoNext: Int32Array;
  /** Texture names (textures/*.wal), one per texinfo. */
  texinfoNames: string[];
  /** Packed faces, FACE_STRIDE ints each. */
  faces: Int32Array;
  /** Raw lightmap bytes. */
  lighting: Uint8Array;
  /** Packed leafs, LEAF_STRIDE ints each. */
  leafs: Int32Array;
  /** Leaf face indices. */
  leaffaces: Uint16Array;
  /** Leaf brush indices. */
  leafbrushes: Uint16Array;
  /** n*2 edge vertex indices. */
  edges: Uint16Array;
  /** Signed edge indices. */
  surfedges: Int32Array;
  /** n*3 model mins/maxs/origin. */
  modelsMins: Float32Array;
  modelsMaxs: Float32Array;
  modelsOrigin: Float32Array;
  /** n*3 model headnode/firstface/numfaces. */
  modelsExtra: Int32Array;
  /** Packed brushes, BRUSH_STRIDE ints each. */
  brushes: Int32Array;
  /** Packed brushsides, BRUSHSIDE_STRIDE ints each. */
  brushsides: Int32Array;
  /** Entity key/value lump as text. */
  entities: string;
  /** Raw POP lump bytes (may be empty). */
  pop: Uint8Array;
  /** Packed areas, AREA_STRIDE ints each. */
  areas: Int32Array;
  /** Packed areaportals, AREAPORTAL_STRIDE ints each. */
  areaportals: Int32Array;
  /** The source bytes (same object identity as formats Bsp38.raw). */
  raw: ArrayBuffer;
}

function checkLump(name: string, ofs: number, len: number, structSize: number, byteLength: number): number {
  if (ofs < 0 || len < 0 || ofs + len > byteLength) {
    Com_Error('fatal', `bad ${name} lump bounds (ofs=${ofs} len=${len} file=${byteLength})`);
  }
  if (structSize > 1 && len % structSize !== 0) {
    Com_Error('fatal', `bad ${name} lump size ${len} (not a multiple of ${structSize})`);
  }
  return len / structSize;
}

function ascii(view: DataView, ofs: number, maxLen: number): string {
  let end = ofs;
  while (end < ofs + maxLen && view.getUint8(end) !== 0) end++;
  const bytes = new Uint8Array(view.buffer, view.byteOffset + ofs, end - ofs);
  return new TextDecoder('ascii').decode(bytes);
}

/** Parse a complete IBSP v38 file into flat typed arrays. Throws ComError on bad data. */
export function loadBsp(buf: ArrayBuffer): BspMap {
  if (buf.byteLength < 8 + HEADER_LUMPS * 8) Com_Error('fatal', 'bsp too small for header');
  const view = new DataView(buf);
  const ident = view.getInt32(0, true);
  const version = view.getInt32(4, true);
  if (ident !== BSP_IDENT) Com_Error('fatal', `bad bsp ident 0x${((ident >>> 0).toString(16))}`);
  if (version !== BSP_VERSION) Com_Error('fatal', `bad bsp version ${version} (want ${BSP_VERSION})`);

  const lumpOfs = new Int32Array(HEADER_LUMPS);
  const lumpLen = new Int32Array(HEADER_LUMPS);
  for (let i = 0; i < HEADER_LUMPS; i++) {
    lumpOfs[i] = view.getInt32(8 + i * 8, true);
    lumpLen[i] = view.getInt32(8 + i * 8 + 4, true);
  }

  // --- planes ---
  const nPlanes = checkLump('planes', lumpOfs[LUMP_PLANES]!, lumpLen[LUMP_PLANES]!, 20, buf.byteLength);
  const planes = new Float32Array(nPlanes * 4);
  const planeTypes = new Int32Array(nPlanes);
  {
    const o = lumpOfs[LUMP_PLANES]!;
    for (let i = 0; i < nPlanes; i++) {
      const b = o + i * 20;
      planes[i * 4] = view.getFloat32(b, true);
      planes[i * 4 + 1] = view.getFloat32(b + 4, true);
      planes[i * 4 + 2] = view.getFloat32(b + 8, true);
      planes[i * 4 + 3] = view.getFloat32(b + 12, true);
      planeTypes[i] = view.getInt32(b + 16, true);
    }
  }

  // --- vertexes ---
  const nVerts = checkLump('vertexes', lumpOfs[LUMP_VERTEXES]!, lumpLen[LUMP_VERTEXES]!, 12, buf.byteLength);
  const vertexes = new Float32Array(nVerts * 3);
  {
    const o = lumpOfs[LUMP_VERTEXES]!;
    for (let i = 0; i < nVerts; i++) {
      vertexes[i * 3] = view.getFloat32(o + i * 12, true);
      vertexes[i * 3 + 1] = view.getFloat32(o + i * 12 + 4, true);
      vertexes[i * 3 + 2] = view.getFloat32(o + i * 12 + 8, true);
    }
  }

  // --- visibility (raw + header decode) ---
  checkLump('visibility', lumpOfs[LUMP_VISIBILITY]!, lumpLen[LUMP_VISIBILITY]!, 1, buf.byteLength);
  const visibility = new Uint8Array(buf.slice(lumpOfs[LUMP_VISIBILITY]!, lumpOfs[LUMP_VISIBILITY]! + lumpLen[LUMP_VISIBILITY]!));
  let numClusters = 0;
  let visBitofs = new Int32Array(0);
  if (visibility.length >= 4) {
    const vview = new DataView(visibility.buffer, visibility.byteOffset, visibility.byteLength);
    numClusters = vview.getInt32(0, true);
    if (numClusters < 0) Com_Error('fatal', `bad numclusters ${numClusters}`);
    if (4 + numClusters * 8 > visibility.length) Com_Error('fatal', 'visibility lump truncated');
    visBitofs = new Int32Array(numClusters * 2);
    for (let i = 0; i < numClusters; i++) {
      visBitofs[i * 2] = vview.getInt32(4 + i * 8, true);
      visBitofs[i * 2 + 1] = vview.getInt32(4 + i * 8 + 4, true);
    }
  }

  // --- nodes ---
  const nNodes = checkLump('nodes', lumpOfs[LUMP_NODES]!, lumpLen[LUMP_NODES]!, 28, buf.byteLength);
  const nodes = new Int32Array(nNodes * NODE_STRIDE);
  const nodeMins = new Int16Array(nNodes * 3);
  const nodeMaxs = new Int16Array(nNodes * 3);
  {
    const o = lumpOfs[LUMP_NODES]!;
    for (let i = 0; i < nNodes; i++) {
      const b = o + i * 28;
      const d = i * NODE_STRIDE;
      nodes[d] = view.getInt32(b, true);
      nodes[d + 1] = view.getInt32(b + 4, true);
      nodes[d + 2] = view.getInt32(b + 8, true);
      for (let k = 0; k < 3; k++) {
        const mn = view.getInt16(b + 12 + k * 2, true);
        const mx = view.getInt16(b + 18 + k * 2, true);
        nodes[d + 3 + k] = mn;
        nodes[d + 6 + k] = mx;
        nodeMins[i * 3 + k] = mn;
        nodeMaxs[i * 3 + k] = mx;
      }
      nodes[d + 9] = view.getUint16(b + 24, true);
      nodes[d + 10] = view.getUint16(b + 26, true);
    }
  }

  // --- texinfo ---
  const nTex = checkLump('texinfo', lumpOfs[LUMP_TEXINFO]!, lumpLen[LUMP_TEXINFO]!, 76, buf.byteLength);
  const texinfoVecs = new Float32Array(nTex * 8);
  const texinfoFlags = new Int32Array(nTex);
  const texinfoValue = new Int32Array(nTex);
  const texinfoNext = new Int32Array(nTex);
  const texinfoNames: string[] = new Array(nTex);
  {
    const o = lumpOfs[LUMP_TEXINFO]!;
    for (let i = 0; i < nTex; i++) {
      const b = o + i * 76;
      for (let k = 0; k < 8; k++) texinfoVecs[i * 8 + k] = view.getFloat32(b + k * 4, true);
      texinfoFlags[i] = view.getInt32(b + 32, true);
      texinfoValue[i] = view.getInt32(b + 36, true);
      texinfoNames[i] = ascii(view, b + 40, 32);
      texinfoNext[i] = view.getInt32(b + 72, true);
    }
  }

  // --- faces ---
  const nFaces = checkLump('faces', lumpOfs[LUMP_FACES]!, lumpLen[LUMP_FACES]!, 20, buf.byteLength);
  const faces = new Int32Array(nFaces * FACE_STRIDE);
  {
    const o = lumpOfs[LUMP_FACES]!;
    for (let i = 0; i < nFaces; i++) {
      const b = o + i * 20;
      const d = i * FACE_STRIDE;
      faces[d] = view.getUint16(b, true);
      faces[d + 1] = view.getInt16(b + 2, true);
      faces[d + 2] = view.getInt32(b + 4, true);
      faces[d + 3] = view.getInt16(b + 8, true);
      faces[d + 4] = view.getInt16(b + 10, true);
      faces[d + 5] = view.getUint8(b + 12);
      faces[d + 6] = view.getUint8(b + 13);
      faces[d + 7] = view.getUint8(b + 14);
      faces[d + 8] = view.getUint8(b + 15);
      faces[d + 9] = view.getInt32(b + 16, true);
    }
  }

  // --- lighting ---
  checkLump('lighting', lumpOfs[LUMP_LIGHTING]!, lumpLen[LUMP_LIGHTING]!, 1, buf.byteLength);
  const lighting = new Uint8Array(buf.slice(lumpOfs[LUMP_LIGHTING]!, lumpOfs[LUMP_LIGHTING]! + lumpLen[LUMP_LIGHTING]!));

  // --- leafs ---
  const nLeafs = checkLump('leafs', lumpOfs[LUMP_LEAFS]!, lumpLen[LUMP_LEAFS]!, 28, buf.byteLength);
  const leafs = new Int32Array(nLeafs * LEAF_STRIDE);
  {
    const o = lumpOfs[LUMP_LEAFS]!;
    for (let i = 0; i < nLeafs; i++) {
      const b = o + i * 28;
      const d = i * LEAF_STRIDE;
      leafs[d] = view.getInt32(b, true);
      leafs[d + 1] = view.getInt16(b + 4, true);
      leafs[d + 2] = view.getInt16(b + 6, true);
      for (let k = 0; k < 3; k++) {
        leafs[d + 3 + k] = view.getInt16(b + 8 + k * 2, true);
        leafs[d + 6 + k] = view.getInt16(b + 14 + k * 2, true);
      }
      leafs[d + 9] = view.getUint16(b + 20, true); // firstleafface
      leafs[d + 10] = view.getUint16(b + 22, true); // numleaffaces
      leafs[d + 11] = view.getUint16(b + 24, true); // firstleafbrush
      leafs[d + 12] = view.getUint16(b + 26, true); // numleafbrushes
    }
  }

  // --- leaffaces / leafbrushes ---
  const nLeafFaces = checkLump('leaffaces', lumpOfs[LUMP_LEAFFACES]!, lumpLen[LUMP_LEAFFACES]!, 2, buf.byteLength);
  const leaffaces = new Uint16Array(nLeafFaces);
  for (let i = 0; i < nLeafFaces; i++) leaffaces[i] = view.getUint16(lumpOfs[LUMP_LEAFFACES]! + i * 2, true);
  const nLeafBrushes = checkLump('leafbrushes', lumpOfs[LUMP_LEAFBRUSHES]!, lumpLen[LUMP_LEAFBRUSHES]!, 2, buf.byteLength);
  const leafbrushes = new Uint16Array(nLeafBrushes);
  for (let i = 0; i < nLeafBrushes; i++) leafbrushes[i] = view.getUint16(lumpOfs[LUMP_LEAFBRUSHES]! + i * 2, true);

  // --- edges / surfedges ---
  const nEdges = checkLump('edges', lumpOfs[LUMP_EDGES]!, lumpLen[LUMP_EDGES]!, 4, buf.byteLength);
  const edges = new Uint16Array(nEdges * 2);
  for (let i = 0; i < nEdges; i++) {
    edges[i * 2] = view.getUint16(lumpOfs[LUMP_EDGES]! + i * 4, true);
    edges[i * 2 + 1] = view.getUint16(lumpOfs[LUMP_EDGES]! + i * 4 + 2, true);
  }
  const nSurf = checkLump('surfedges', lumpOfs[LUMP_SURFEDGES]!, lumpLen[LUMP_SURFEDGES]!, 4, buf.byteLength);
  const surfedges = new Int32Array(nSurf);
  for (let i = 0; i < nSurf; i++) surfedges[i] = view.getInt32(lumpOfs[LUMP_SURFEDGES]! + i * 4, true);

  // --- models ---
  const nModels = checkLump('models', lumpOfs[LUMP_MODELS]!, lumpLen[LUMP_MODELS]!, 48, buf.byteLength);
  const modelsMins = new Float32Array(nModels * 3);
  const modelsMaxs = new Float32Array(nModels * 3);
  const modelsOrigin = new Float32Array(nModels * 3);
  const modelsExtra = new Int32Array(nModels * MODEL_EXTRA_STRIDE);
  {
    const o = lumpOfs[LUMP_MODELS]!;
    for (let i = 0; i < nModels; i++) {
      const b = o + i * 48;
      for (let k = 0; k < 3; k++) {
        modelsMins[i * 3 + k] = view.getFloat32(b + k * 4, true);
        modelsMaxs[i * 3 + k] = view.getFloat32(b + 12 + k * 4, true);
        modelsOrigin[i * 3 + k] = view.getFloat32(b + 24 + k * 4, true);
      }
      modelsExtra[i * 3] = view.getInt32(b + 36, true);
      modelsExtra[i * 3 + 1] = view.getInt32(b + 40, true);
      modelsExtra[i * 3 + 2] = view.getInt32(b + 44, true);
    }
  }

  // --- brushes ---
  const nBrushes = checkLump('brushes', lumpOfs[LUMP_BRUSHES]!, lumpLen[LUMP_BRUSHES]!, 12, buf.byteLength);
  const brushes = new Int32Array(nBrushes * BRUSH_STRIDE);
  for (let i = 0; i < nBrushes; i++) {
    brushes[i * 3] = view.getInt32(lumpOfs[LUMP_BRUSHES]! + i * 12, true);
    brushes[i * 3 + 1] = view.getInt32(lumpOfs[LUMP_BRUSHES]! + i * 12 + 4, true);
    brushes[i * 3 + 2] = view.getInt32(lumpOfs[LUMP_BRUSHES]! + i * 12 + 8, true);
  }

  // --- brushsides ---
  const nSides = checkLump('brushsides', lumpOfs[LUMP_BRUSHSIDES]!, lumpLen[LUMP_BRUSHSIDES]!, 4, buf.byteLength);
  const brushsides = new Int32Array(nSides * BRUSHSIDE_STRIDE);
  for (let i = 0; i < nSides; i++) {
    brushsides[i * 2] = view.getUint16(lumpOfs[LUMP_BRUSHSIDES]! + i * 4, true);
    brushsides[i * 2 + 1] = view.getInt16(lumpOfs[LUMP_BRUSHSIDES]! + i * 4 + 2, true);
  }

  // --- entities / pop / areas / areaportals ---
  checkLump('entities', lumpOfs[LUMP_ENTITIES]!, lumpLen[LUMP_ENTITIES]!, 1, buf.byteLength);
  const entBytes = new Uint8Array(buf, lumpOfs[LUMP_ENTITIES]!, lumpLen[LUMP_ENTITIES]!);
  const entities = new TextDecoder('ascii').decode(entBytes);
  checkLump('pop', lumpOfs[LUMP_POP]!, lumpLen[LUMP_POP]!, 1, buf.byteLength);
  const pop = new Uint8Array(buf.slice(lumpOfs[LUMP_POP]!, lumpOfs[LUMP_POP]! + lumpLen[LUMP_POP]!));
  const nAreas = checkLump('areas', lumpOfs[LUMP_AREAS]!, lumpLen[LUMP_AREAS]!, 8, buf.byteLength);
  const areas = new Int32Array(nAreas * AREA_STRIDE);
  for (let i = 0; i < nAreas; i++) {
    areas[i * 2] = view.getInt32(lumpOfs[LUMP_AREAS]! + i * 8, true);
    areas[i * 2 + 1] = view.getInt32(lumpOfs[LUMP_AREAS]! + i * 8 + 4, true);
  }
  const nPortals = checkLump('areaportals', lumpOfs[LUMP_AREAPORTALS]!, lumpLen[LUMP_AREAPORTALS]!, 8, buf.byteLength);
  const areaportals = new Int32Array(nPortals * AREAPORTAL_STRIDE);
  for (let i = 0; i < nPortals; i++) {
    areaportals[i * 2] = view.getInt32(lumpOfs[LUMP_AREAPORTALS]! + i * 8, true);
    areaportals[i * 2 + 1] = view.getInt32(lumpOfs[LUMP_AREAPORTALS]! + i * 8 + 4, true);
  }

  return {
    planes, planeTypes, vertexes, visibility, numClusters, visBitofs,
    nodes, nodeMins, nodeMaxs,
    texinfoVecs, texinfoFlags, texinfoValue, texinfoNext, texinfoNames,
    faces, lighting, leafs, leaffaces, leafbrushes, edges, surfedges,
    modelsMins, modelsMaxs, modelsOrigin, modelsExtra,
    brushes, brushsides, entities, pop, areas, areaportals, raw: buf,
  };
}

/** Lump element counts for stats/reporting. */
export function lumpCounts(w: BspMap): Record<string, number> {
  return {
    entities: w.entities.length,
    planes: w.planes.length / 4,
    vertexes: w.vertexes.length / 3,
    visibility: w.visibility.length,
    nodes: w.nodes.length / NODE_STRIDE,
    texinfo: w.texinfoFlags.length,
    faces: w.faces.length / FACE_STRIDE,
    lighting: w.lighting.length,
    leafs: w.leafs.length / LEAF_STRIDE,
    leaffaces: w.leaffaces.length,
    leafbrushes: w.leafbrushes.length,
    edges: w.edges.length / 2,
    surfedges: w.surfedges.length,
    models: w.modelsExtra.length / MODEL_EXTRA_STRIDE,
    brushes: w.brushes.length / BRUSH_STRIDE,
    brushsides: w.brushsides.length / BRUSHSIDE_STRIDE,
    pop: w.pop.length,
    areas: w.areas.length / AREA_STRIDE,
    areaportals: w.areaportals.length / AREAPORTAL_STRIDE,
  };
}
