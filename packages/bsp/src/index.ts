// @q2/bsp — node/leaf traversal, PVS decompression, trace/clip hulls. M2.1 owns this.
export { loadBsp, lumpCounts } from './bsp38.js';
export type { BspMap } from './bsp38.js';
export {
  BSP_IDENT, BSP_VERSION, HEADER_LUMPS,
  LUMP_ENTITIES, LUMP_PLANES, LUMP_VERTEXES, LUMP_VISIBILITY, LUMP_NODES,
  LUMP_TEXINFO, LUMP_FACES, LUMP_LIGHTING, LUMP_LEAFS, LUMP_LEAFFACES,
  LUMP_LEAFBRUSHES, LUMP_EDGES, LUMP_SURFEDGES, LUMP_MODELS, LUMP_BRUSHES,
  LUMP_BRUSHSIDES, LUMP_POP, LUMP_AREAS, LUMP_AREAPORTALS,
  NODE_STRIDE, LEAF_STRIDE, FACE_STRIDE, BRUSH_STRIDE, BRUSHSIDE_STRIDE,
  MODEL_EXTRA_STRIDE, AREA_STRIDE, AREAPORTAL_STRIDE,
} from './bsp38.js';
export { clusterPVS, decompressVis } from './pvs.js';
export { traceBox, pointLeaf, DIST_EPSILON, SURF_SKY } from './trace.js';
export type { Trace } from './trace.js';
