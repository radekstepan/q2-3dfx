// Shared synthetic BSP38 builder for tests: a 20-unit solid cube brush
// (x/y/z in [-10,10]) sitting in an empty leaf, split by node plane x=0.
//
// nodes:  root plane x=0; front (x>=0) -> leaf 1 (empty, holds the brush),
//         back -> leaf 0 (solid, structural).

export function buildTestMap(): ArrayBuffer {
  const i32 = (v: number[]): Uint8Array => {
    const b = new Uint8Array(v.length * 4);
    const dv = new DataView(b.buffer);
    v.forEach((x, i) => dv.setInt32(i * 4, x, true));
    return b;
  };

  const enc = new TextEncoder();
  const entities = enc.encode('{}\n');

  // planes: [node x=0] + 6 brush box faces (20B each)
  const planeData: number[][] = [
    [1, 0, 0, 0, 0],
    [1, 0, 0, 10, 0], [-1, 0, 0, 10, 0],
    [0, 1, 0, 10, 1], [0, -1, 0, 10, 1],
    [0, 0, 1, 10, 2], [0, 0, -1, 10, 2],
  ];
  const planes = new Uint8Array(7 * 20);
  {
    const dv = new DataView(planes.buffer);
    planeData.forEach((p, i) => {
      dv.setFloat32(i * 20, p[0]!, true);
      dv.setFloat32(i * 20 + 4, p[1]!, true);
      dv.setFloat32(i * 20 + 8, p[2]!, true);
      dv.setFloat32(i * 20 + 12, p[3]!, true);
      dv.setInt32(i * 20 + 16, p[4]!, true);
    });
  }

  const vertexes = new Uint8Array(4 * 12);
  {
    const dv = new DataView(vertexes.buffer);
    [[-10, -10, -10], [10, -10, -10], [10, 10, -10], [-10, 10, -10]].forEach((v, i) => {
      dv.setFloat32(i * 12, v[0]!, true);
      dv.setFloat32(i * 12 + 4, v[1]!, true);
      dv.setFloat32(i * 12 + 8, v[2]!, true);
    });
  }

  const visibility = new Uint8Array(0);

  // node: planenum 0, children [-2, -1], mins/maxs, firstface 0, numfaces 0
  const nodes = new Uint8Array(28);
  {
    const dv = new DataView(nodes.buffer);
    dv.setInt32(0, 0, true);
    dv.setInt32(4, -2, true);
    dv.setInt32(8, -1, true);
    [-128, -128, -128, 127, 127, 127].forEach((v, i) => dv.setInt16(12 + i * 2, v, true));
    dv.setUint16(24, 0, true);
    dv.setUint16(26, 0, true);
  }

  // texinfo: zero vecs, flags 0, value 0, name "test", next -1
  const texinfo = new Uint8Array(76);
  {
    const dv = new DataView(texinfo.buffer);
    enc.encodeInto('test', new Uint8Array(texinfo.buffer, 40, 32));
    dv.setInt32(72, -1, true);
  }

  // face: dummy, lightofs -1
  const faces = new Uint8Array(20);
  new DataView(faces.buffer).setInt32(16, -1, true);
  const lighting = new Uint8Array(0);

  // leafs: [solid structural] [solid: holds the wall brush]
  const leafs = new Uint8Array(2 * 28);
  {
    const dv = new DataView(leafs.buffer);
    dv.setInt32(0, 1, true); // contents SOLID
    dv.setInt16(4, -1, true); // cluster -1
    dv.setInt32(28 + 0, 1, true); // leaf1 contents SOLID (OR of its brushes, as QBSP emits)
    dv.setInt16(28 + 4, 0, true); // cluster 0
    dv.setUint16(28 + 24, 0, true); // firstleafbrush
    dv.setUint16(28 + 26, 1, true); // numleafbrushes
  }

  const leaffaces = new Uint8Array(2);
  const leafbrushes = new Uint8Array(2); // [0]
  const edges = new Uint8Array(8); // v 0,1
  {
    const dv = new DataView(edges.buffer);
    dv.setUint16(0, 0, true);
    dv.setUint16(2, 1, true);
  }
  const surfedges = i32([1]);

  // model: bounds +-100, origin 0, headnode 0, faces [0,1)
  const models = new Uint8Array(48);
  {
    const dv = new DataView(models.buffer);
    [-100, -100, -100].forEach((v, i) => dv.setFloat32(i * 4, v, true));
    [100, 100, 100].forEach((v, i) => dv.setFloat32(12 + i * 4, v, true));
    dv.setInt32(36, 0, true);
    dv.setInt32(44, 1, true);
  }

  // brush: box, CONTENTS_SOLID
  const brushes = i32([0, 6, 1]);
  const brushsides = new Uint8Array(6 * 4);
  {
    const dv = new DataView(brushsides.buffer);
    for (let i = 0; i < 6; i++) {
      dv.setUint16(i * 4, i + 1, true);
      dv.setInt16(i * 4 + 2, 0, true);
    }
  }

  const pop = new Uint8Array(0);
  const areas = i32([0, 0]);
  const areaportals = new Uint8Array(0);

  const lumps: Uint8Array[] = [
    entities, planes, vertexes, visibility, nodes,
    texinfo, faces, lighting, leafs, leaffaces,
    leafbrushes, edges, surfedges, models, brushes,
    brushsides, pop, areas, areaportals,
  ];

  const headerLen = 8 + 19 * 8;
  let cursor = headerLen;
  const lumpTable: number[] = [];
  const bodies: Uint8Array[] = [];
  for (const body of lumps) {
    lumpTable.push(cursor, body.length);
    bodies.push(body);
    cursor += body.length;
  }
  const header = new Uint8Array(headerLen);
  {
    const dv = new DataView(header.buffer);
    dv.setInt32(0, 0x50534249, true); // "IBSP"
    dv.setInt32(4, 38, true);
    lumpTable.forEach((v, i) => dv.setInt32(8 + i * 4, v, true));
  }
  const out = new Uint8Array(cursor);
  out.set(header, 0);
  let p = headerLen;
  for (const b of bodies) { out.set(b, p); p += b.length; }
  return out.buffer as ArrayBuffer;
}
