// M2.1: all 19 lumps parse from a synthetic map; bad headers rejected.
import { describe, expect, it } from 'vitest';
import { loadBsp, lumpCounts } from './index.js';
import { buildTestMap } from './testmap.js';

describe('loadBsp', () => {
  it('parses all 19 lumps of the synthetic map', () => {
    const w = loadBsp(buildTestMap());
    expect(lumpCounts(w)).toEqual({
      entities: 3,
      planes: 7,
      vertexes: 4,
      visibility: 0,
      nodes: 1,
      texinfo: 1,
      faces: 1,
      lighting: 0,
      leafs: 2,
      leaffaces: 1,
      leafbrushes: 1,
      edges: 2,
      surfedges: 1,
      models: 1,
      brushes: 1,
      brushsides: 6,
      pop: 0,
      areas: 1,
      areaportals: 0,
    });

    // spot values
    expect(w.planes[0]).toBe(1); // node plane normal +X
    expect(w.planes[3]).toBe(0);
    expect(w.planeTypes[0]).toBe(0);
    expect(w.nodes[0]).toBe(0); // planenum
    expect(w.nodes[1]).toBe(-2); // front -> leaf 1
    expect(w.nodes[2]).toBe(-1); // back -> leaf 0
    expect(w.leafs[0]).toBe(1); // leaf 0 SOLID
    expect(w.leafs[1]).toBe(-1); // cluster -1
    expect(w.leafs[13]).toBe(1); // leaf 1 contents SOLID (holds the brush)
    expect(w.leafs[13 + 1]).toBe(0); // leaf 1 cluster 0
    expect(w.leafs[13 + 11]).toBe(0); // leaf 1 firstleafbrush
    expect(w.leafs[13 + 12]).toBe(1); // leaf 1 numleafbrushes
    expect(w.leafbrushes[0]).toBe(0);
    expect(w.brushes[0]).toBe(0); // firstside
    expect(w.brushes[1]).toBe(6); // numsides
    expect(w.brushes[2]).toBe(1); // CONTENTS_SOLID
    expect(w.brushsides[0]).toBe(1); // first side -> plane 1 (+X d=10)
    expect(w.texinfoNames[0]).toBe('test');
    expect(w.texinfoNext[0]).toBe(-1);
    expect(w.faces[9]).toBe(-1); // lightofs
    expect(w.modelsExtra[0]).toBe(0); // headnode
    expect(w.entities).toBe('{}\n');
    expect(w.vertexes.length).toBe(12);
    expect(w.nodeMins.length).toBe(3);
    expect(w.areas[0]).toBe(0);
    expect(w.numClusters).toBe(0);
    expect(w.raw.byteLength).toBeGreaterThan(160);
  });

  it('rejects a bad ident', () => {
    const buf = buildTestMap().slice(0);
    new DataView(buf).setInt32(0, 0xdeadbeef | 0, true);
    expect(() => loadBsp(buf)).toThrow();
  });

  it('rejects a bad version', () => {
    const buf = buildTestMap().slice(0);
    new DataView(buf).setInt32(4, 39, true);
    expect(() => loadBsp(buf)).toThrow();
  });

  it('rejects a truncated lump', () => {
    const buf = buildTestMap().slice(0, 200);
    expect(() => loadBsp(buf)).toThrow();
  });
});
