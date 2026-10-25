// M2.1: PVS RLE decompression — unit cases plus a fixture captured from
// real base1.bsp (numclusters=1446, row=181). Fixture generated from
// maps/base1.bsp in pak0.pak with an independent port of CM_DecompressVis.
import { describe, expect, it } from 'vitest';
import { clusterPVS, decompressVis, loadBsp } from './index.js';
import type { BspMap } from './index.js';
import { buildTestMap } from './testmap.js';
import { base1PvsFixture as fixture } from './fixtures/base1-pvs.js';

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i)!;
  return o;
}

function b64encode(u: Uint8Array): string {
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
}

describe('decompressVis', () => {
  it('copies literals verbatim', () => {
    const out = new Uint8Array(4);
    decompressVis(new Uint8Array([0x11, 0x22, 0x33, 0x44]), 0, 0, out);
    // offset 0 means "no vis": all-visible. Use a padded buffer instead.
    const src = new Uint8Array([0, 0x11, 0x22, 0x33, 0x44]);
    decompressVis(src, 1, 32, out);
    expect(Array.from(out)).toEqual([0x11, 0x22, 0x33, 0x44]);
  });

  it('expands zero runs', () => {
    const out = new Uint8Array(6);
    decompressVis(new Uint8Array([0, 0xaa, 0, 4, 0xbb]), 1, 48, out);
    expect(Array.from(out)).toEqual([0xaa, 0, 0, 0, 0, 0xbb]);
  });

  it('clamps overruns like the C code', () => {
    const out = new Uint8Array(3);
    decompressVis(new Uint8Array([0, 0, 99]), 1, 24, out);
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });

  it('all-visible when there is no vis lump', () => {
    const out = new Uint8Array(5);
    decompressVis(new Uint8Array(0), 8, 40, out);
    expect(Array.from(out)).toEqual([255, 255, 255, 255, 255]);
  });

  it('offset 0 (cluster -1 convention) yields all-visible', () => {
    const out = new Uint8Array(3);
    decompressVis(new Uint8Array([1, 2, 3]), 0, 24, out);
    expect(Array.from(out)).toEqual([255, 255, 255]);
  });
});

describe('base1 PVS fixture', () => {
  it('has the expected map stats', () => {
    expect(fixture.numclusters).toBe(1446);
    expect(fixture.row).toBe(181);
    expect(fixture.worldMins).toEqual([-2192, -960, -464]);
    expect(fixture.worldMaxs).toEqual([1464, 2000, 904]);
  });

  for (const id of Object.keys(fixture.clusters)) {
    it(`decompresses cluster ${id} exactly`, () => {
      const c = fixture.clusters[id]!;
      const src = b64decode(c.pvsInB64);
      const padded = new Uint8Array(src.length + 3);
      padded.set(src, 1); // offset 1: offset 0 is the "no vis" sentinel
      const out = new Uint8Array(fixture.row);
      decompressVis(padded, 1, fixture.numclusters, out);
      expect(b64encode(out)).toBe(c.pvsB64);
      expect(Array.from(out.subarray(0, 16))).toEqual(c.pvsHead);
      let sum = 0;
      for (const b of out) sum += b;
      expect(sum).toBe(c.pvsSum);
    });
  }

  it('clusterPVS routes through visBitofs like CM_ClusterPVS', () => {
    // Assemble a visibility lump from the recorded rows at fresh offsets.
    const ids = Object.keys(fixture.clusters).map(Number);
    const rows = ids.map((id) => b64decode(fixture.clusters[String(id)]!.pvsInB64));
    const w = loadBsp(buildTestMap()) as BspMap;
    const maxId = Math.max(...ids);
    const vis = new Uint8Array(4 + (maxId + 1) * 8 + rows.reduce((a, r) => a + r.length, 0));
    const dv = new DataView(vis.buffer);
    dv.setInt32(0, maxId + 1, true);
    let p = 4 + (maxId + 1) * 8;
    for (let k = 0; k < ids.length; k++) {
      dv.setInt32(4 + ids[k]! * 8, p, true);
      vis.set(rows[k]!, p);
      p += rows[k]!.length;
    }
    w.visibility = vis;
    w.numClusters = maxId + 1;
    const bitofs = new Int32Array((maxId + 1) * 2);
    for (let i = 0; i <= maxId; i++) {
      bitofs[i * 2] = dv.getInt32(4 + i * 8, true);
      bitofs[i * 2 + 1] = dv.getInt32(4 + i * 8 + 4, true);
    }
    w.visBitofs = bitofs;

    const row = (maxId + 1 + 7) >> 3;
    expect(row).toBe(181); // same width as base1: full-row comparison
    for (const id of ids) {
      const got = clusterPVS(w, id);
      expect(got.length).toBe(row);
      expect(b64encode(got)).toBe(fixture.clusters[String(id)]!.pvsB64);
    }
    // negative cluster -> zeros (solid), as in C
    expect(Array.from(clusterPVS(w, -1))).toEqual(new Array(row).fill(0));
  });
});
