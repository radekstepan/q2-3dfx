// map-viewer loader tests: file selection, PAK map listing, BSP rejection,
// repeated loading. Fixtures are synthetic only: the shared builder from
// @q2/bsp's testmap (imported from source because it is not part of the
// package's public exports and shared packages stay untouched) plus
// hand-built minimal PAK/WAL bytes. No proprietary assets.
import { describe, expect, it } from 'vitest';
import {
  collectMissingAssets,
  loadPakMap,
  loadStandaloneBsp,
  parsePakFile,
  resolveColormapPcx,
  resolveTexelFor,
  validateBsp,
} from './loader.js';
import {
  describePrecedence,
  listPakMaps,
  shortMapName,
  summarizePak,
} from './pak-view.js';
import type { WebPak } from '../pak.js';

function bspFile(name = 'e1m1.bsp', buf: ArrayBuffer = buildTestMap()): File {
  return new File([buf], name);
}

/**
 * Minimal synthetic IBSP v38: all 19 lumps present, one texinfo named "test",
 * empty lighting/visibility, `{}` entities (no player start). Mirrors the
 * properties of @q2/bsp's shared buildTestMap that these tests rely on;
 * defined locally because testmap.ts is not part of @q2/bsp's public exports
 * (and shared packages stay untouched).
 */
function buildTestMap(): ArrayBuffer {
  const enc = new TextEncoder();
  const entities = enc.encode('{}\n');
  const texinfo = new Uint8Array(76);
  enc.encodeInto('test', texinfo.subarray(40, 72));
  new DataView(texinfo.buffer).setInt32(72, -1, true);
  const models = new Uint8Array(48); // zeroed: headnode 0, no faces
  const lumps: Uint8Array[] = [
    entities, // 0 entities
    new Uint8Array(0), // 1 planes
    new Uint8Array(0), // 2 vertexes
    new Uint8Array(0), // 3 visibility
    new Uint8Array(0), // 4 nodes
    texinfo, // 5 texinfo
    new Uint8Array(0), // 6 faces
    new Uint8Array(0), // 7 lighting
    new Uint8Array(0), // 8 leafs
    new Uint8Array(0), // 9 leaffaces
    new Uint8Array(0), // 10 leafbrushes
    new Uint8Array(0), // 11 edges
    new Uint8Array(0), // 12 surfedges
    models, // 13 models
    new Uint8Array(0), // 14 brushes
    new Uint8Array(0), // 15 brushsides
    new Uint8Array(0), // 16 pop
    new Uint8Array(0), // 17 areas
    new Uint8Array(0), // 18 areaportals
  ];
  const headerLen = 8 + 19 * 8;
  let cursor = headerLen;
  const table: number[] = [];
  for (const body of lumps) {
    table.push(cursor, body.length);
    cursor += body.length;
  }
  const out = new Uint8Array(cursor);
  const view = new DataView(out.buffer);
  view.setInt32(0, 0x50534249, true); // "IBSP"
  view.setInt32(4, 38, true);
  table.forEach((v, i) => view.setInt32(8 + i * 4, v, true));
  let p = headerLen;
  for (const b of lumps) {
    out.set(b, p);
    p += b.length;
  }
  return out.buffer;
}

/** Rebuild test-map bytes with a different entities lump (byte surgery). */
function withEntities(buf: ArrayBuffer, text: string): ArrayBuffer {
  const view = new DataView(buf);
  const oldOfs = view.getInt32(8, true);
  const oldLen = view.getInt32(12, true);
  const ent = new TextEncoder().encode(text);
  const delta = ent.length - oldLen;
  const out = new Uint8Array(buf.byteLength + delta);
  const src = new Uint8Array(buf);
  out.set(src.subarray(0, oldOfs), 0);
  out.set(ent, oldOfs);
  out.set(src.subarray(oldOfs + oldLen), oldOfs + ent.length);
  const oview = new DataView(out.buffer);
  oview.setInt32(12, ent.length, true);
  for (let i = 1; i < 19; i++) {
    const lump = 8 + i * 8;
    oview.setInt32(lump, oview.getInt32(lump, true) + delta, true);
  }
  return out.buffer;
}

/** Minimal valid .wal: 8x8 + mips, every byte set to fill. */
function buildWal(name: string, fill: number, w = 8, h = 8): ArrayBuffer {
  const sizes = [w * h, (w * h) >> 2, (w * h) >> 4, (w * h) >> 6];
  const total = 100 + sizes[0]! + sizes[1]! + sizes[2]! + sizes[3]!;
  const buf = new ArrayBuffer(total);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const enc = new TextEncoder().encode(name);
  bytes.set(enc.subarray(0, Math.min(enc.length, 32)), 0);
  view.setUint32(32, w, true);
  view.setUint32(36, h, true);
  let off = 100;
  for (let k = 0; k < 4; k++) {
    view.setUint32(40 + k * 4, off, true);
    bytes.fill(fill, off, off + sizes[k]!);
    off += sizes[k]!;
  }
  return buf;
}

/** Minimal PACK: header, concatenated data, trailing directory. */
function buildPak(files: Array<{ name: string; data: ArrayBuffer }>): ArrayBuffer {
  const blobs = files.map((f) => ({ name: f.name, bytes: new Uint8Array(f.data) }));
  let dataLen = 0;
  for (const b of blobs) dataLen += b.bytes.length;
  const dirOffset = 12 + dataLen;
  const buf = new ArrayBuffer(dirOffset + blobs.length * 64);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  bytes.set([0x50, 0x41, 0x43, 0x4b], 0); // PACK
  view.setUint32(4, dirOffset, true);
  view.setUint32(8, blobs.length * 64, true);
  let p = 12;
  const metas: Array<{ name: string; offset: number; size: number }> = [];
  for (const b of blobs) {
    metas.push({ name: b.name, offset: p, size: b.bytes.length });
    bytes.set(b.bytes, p);
    p += b.bytes.length;
  }
  metas.forEach((m, i) => {
    const off = dirOffset + i * 64;
    const enc = new TextEncoder().encode(m.name);
    bytes.set(enc.subarray(0, Math.min(enc.length, 56)), off);
    view.setUint32(off + 56, m.offset, true);
    view.setUint32(off + 60, m.size, true);
  });
  return buf;
}

function pakFile(files: Array<{ name: string; data: ArrayBuffer }>, name = 'maps.pak'): File {
  return new File([buildPak(files)], name);
}

describe('validateBsp', () => {
  it('parses the synthetic map', () => {
    const map = validateBsp(buildTestMap());
    expect(map.texinfoNames).toEqual(['test']);
  });

  it('rejects truncated input', () => {
    expect(() => validateBsp(new ArrayBuffer(8))).toThrow(/invalid BSP/);
  });

  it('rejects a bad ident', () => {
    const buf = buildTestMap().slice(0);
    new DataView(buf).setInt32(0, 0x12345678, true);
    expect(() => validateBsp(buf)).toThrow(/invalid BSP/);
  });

  it('rejects an unsupported version with the version named', () => {
    const buf = buildTestMap().slice(0);
    new DataView(buf).setInt32(4, 39, true);
    expect(() => validateBsp(buf)).toThrow(/version 39/);
  });

  it('rejects truncated lumps', () => {
    const buf = buildTestMap().slice(0, 200);
    expect(() => validateBsp(buf)).toThrow(/invalid BSP/);
  });
});

describe('loadStandaloneBsp', () => {
  it('loads a picked file with a missing-asset summary (no warning flood)', async () => {
    const loaded = await loadStandaloneBsp(bspFile());
    expect(loaded.name).toBe('e1m1');
    expect(loaded.source).toBe('file:e1m1.bsp');
    expect(loaded.bsp.texinfoNames).toEqual(['test']);
    // One entry per gap: texture + palette + lighting + vis + spawn.
    expect(loaded.missingAssets).toContain('texture:test');
    expect(loaded.missingAssets).toContain('palette:pics/colormap.pcx');
    expect(loaded.missingAssets.some((m) => m.startsWith('lighting:'))).toBe(true);
    expect(loaded.missingAssets.some((m) => m.startsWith('vis:'))).toBe(true);
    expect(loaded.missingAssets.some((m) => m.startsWith('spawn:'))).toBe(true);
    expect(loaded.missingAssets.length).toBe(5);
  });

  it('resolves textures/palette from asset PAKs', async () => {
    // Re-parse through the real ingest path to prove the bytes are genuine.
    const parsed = await parsePakFile(pakFile([
      { name: 'textures/test.wal', data: buildWal('test', 7) },
      { name: 'pics/colormap.pcx', data: new ArrayBuffer(16) },
    ]));
    expect(parsed.entries.length).toBe(2);
    const loaded = await loadStandaloneBsp(bspFile(), [parsed]);
    expect(loaded.missingAssets).not.toContain('texture:test');
    expect(loaded.missingAssets).not.toContain('palette:pics/colormap.pcx');
    expect(loaded.missingAssets.some((m) => m.startsWith('lighting:'))).toBe(true);
  });

  it('rejects garbage with a recoverable error', async () => {
    await expect(loadStandaloneBsp(bspFile('bad.bsp', new ArrayBuffer(64)))).rejects.toThrow(
      /invalid BSP/,
    );
  });

  it('reports a player start instead of a spawn gap when present', async () => {
    const buf = withEntities(
      buildTestMap(),
      '{"classname" "worldspawn"}\n{"classname" "info_player_start" "origin" "0 0 8"}\n',
    );
    const loaded = await loadStandaloneBsp(bspFile('spawn.bsp', buf));
    expect(loaded.missingAssets.some((m) => m.startsWith('spawn:'))).toBe(false);
    // Without a resolver every referenced texture stays unresolved.
    expect(collectMissingAssets(loaded.bsp)).toContain('texture:test');
  });
});

describe('PAK map listing', () => {
  const files = () => [
    { name: 'maps/a.bsp', data: buildTestMap() },
    { name: 'MAPS/B.BSP', data: buildTestMap() },
    { name: 'textures/test.wal', data: buildWal('test', 3) },
    { name: 'pics/colormap.pcx', data: new ArrayBuffer(16) },
    { name: 'sound/world/x.wav', data: new ArrayBuffer(8) },
  ];

  it('lists maps/*.bsp sorted, lowercased, ignoring the rest', async () => {
    const pak = await parsePakFile(pakFile(files()));
    expect(listPakMaps(pak)).toEqual(['maps/a.bsp', 'maps/b.bsp']);
  });

  it('summarizes and shortens names', async () => {
    const pak = await parsePakFile(pakFile(files()));
    expect(shortMapName('maps/a.bsp')).toBe('a');
    expect(summarizePak(pak)).toContain('2 map(s)');
    expect(summarizePak(pak)).toContain('palette present');
  });

  it('loads a map from the PAK with same-PAK textures resolved', async () => {
    const pak = await parsePakFile(pakFile(files()));
    const loaded = loadPakMap(pak, 'maps/a.bsp');
    expect(loaded.name).toBe('a');
    expect(loaded.source).toBe('pak:maps/a.bsp');
    expect(loaded.missingAssets).not.toContain('texture:test');
    expect(loaded.missingAssets).not.toContain('palette:pics/colormap.pcx');
  });

  it('rejects unknown lumps and bad PAK bytes', async () => {
    const pak = await parsePakFile(pakFile(files()));
    expect(() => loadPakMap(pak, 'maps/nope.bsp')).toThrow(/not in PAK/);
    await expect(parsePakFile(new File([new ArrayBuffer(16)], 'junk.pak'))).rejects.toThrow(
      /invalid PAK junk.pak/,
    );
  });
});

describe('resolveTexelFor', () => {
  it('returns null with no asset PAKs', () => {
    expect(resolveTexelFor([])('test')).toBeNull();
  });

  it('first-listed PAK wins ties', async () => {
    const first = await parsePakFile(pakFile([{ name: 'textures/test.wal', data: buildWal('test', 7) }], 'first.pak'));
    const second = await parsePakFile(pakFile([{ name: 'textures/test.wal', data: buildWal('test', 9) }], 'second.pak'));
    const texel = resolveTexelFor([first, second])('test');
    expect(texel?.width).toBe(8);
    expect(texel?.height).toBe(8);
    expect(texel?.texels[0]).toBe(7);
  });

  it('falls through corrupt WALs and normalizes names', async () => {
    const corrupt = await parsePakFile(pakFile([{ name: 'textures/test.wal', data: new ArrayBuffer(10) }]));
    const good = await parsePakFile(pakFile([{ name: 'textures/test.wal', data: buildWal('test', 5) }]));
    const texelFor = resolveTexelFor([corrupt, good]);
    expect(texelFor('test')?.texels[0]).toBe(5);
    expect(texelFor('textures/test.wal')?.texels[0]).toBe(5);
    expect(texelFor('TEST')?.texels[0]).toBe(5);
    expect(texelFor('missing')).toBeNull();
  });
});

describe('repeated loading', () => {
  it('loads map after map, each with its own summary', async () => {
    const plain = await loadStandaloneBsp(bspFile('first.bsp'));
    const spawned = await loadStandaloneBsp(
      bspFile(
        'second.bsp',
        withEntities(buildTestMap(), '{"classname" "info_player_start"}\n'),
      ),
    );
    expect(plain.name).toBe('first');
    expect(spawned.name).toBe('second');
    expect(plain.missingAssets.some((m) => m.startsWith('spawn:'))).toBe(true);
    expect(spawned.missingAssets.some((m) => m.startsWith('spawn:'))).toBe(false);
    // A bad file after good ones still rejects cleanly (recoverable).
    await expect(loadStandaloneBsp(bspFile('bad.bsp', new ArrayBuffer(0)))).rejects.toThrow(
      /invalid BSP/,
    );
    const again = await loadStandaloneBsp(bspFile('third.bsp'));
    expect(again.name).toBe('third');
  });
});

describe('describePrecedence', () => {
  it('covers empty and ordered slots', () => {
    expect(describePrecedence([])).toContain('no asset PAKs');
    const text = describePrecedence([
      { label: 'pak0.pak', pak: { entries: [], data: new ArrayBuffer(0) } },
      { label: 'extra.pak', pak: { entries: [], data: new ArrayBuffer(0) } },
    ]);
    expect(text).toBe('1. pak0.pak (wins ties)\n2. extra.pak');
  });
});

describe('resolveColormapPcx', () => {
  /** 4x1 PCX: RLE run of index 7 + 0x0C marker + 768-byte palette. */
  function buildPcx(paletteFill: (i: number) => number): ArrayBuffer {
    const total = 128 + 2 + 1 + 768;
    const buf = new ArrayBuffer(total);
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);
    bytes[0] = 0x0a; // manufacturer
    bytes[1] = 5; // version
    bytes[2] = 1; // RLE
    bytes[3] = 8; // 8bpp
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, 3, true); // xmax -> width 4
    view.setUint16(10, 0, true); // ymax -> height 1
    bytes[65] = 1; // planes
    bytes[128] = 0xc4; // run of 4
    bytes[129] = 7;
    bytes[130] = 0x0c; // palette marker
    for (let i = 0; i < 768; i++) bytes[131 + i] = paletteFill(i);
    return buf;
  }

  it('returns null when no PAK carries the colormap', async () => {
    const pak = await parsePakFile(pakFile([{ name: 'maps/x.bsp', data: buildTestMap() }]));
    expect(resolveColormapPcx([pak])).toBeNull();
    expect(resolveColormapPcx([])).toBeNull();
  });

  it('parses the palette from an asset PAK; first-listed wins', async () => {
    const first = await parsePakFile(
      pakFile([{ name: 'pics/colormap.pcx', data: buildPcx((i) => i & 255) }], 'first.pak'),
    );
    const second = await parsePakFile(
      pakFile([{ name: 'pics/colormap.pcx', data: buildPcx(() => 200) }], 'second.pak'),
    );
    const cm = resolveColormapPcx([first, second]);
    expect(cm).not.toBeNull();
    expect(cm!.palette.length).toBe(768);
    expect(cm!.palette[3]).toBe(3);
    expect(cm!.pixels.length).toBe(4);
    // Falls back to the map PAK when asset PAKs lack it.
    const noPal = await parsePakFile(pakFile([{ name: 'maps/x.bsp', data: buildTestMap() }]));
    const fromMap = resolveColormapPcx([noPal], second);
    expect(fromMap!.palette[0]).toBe(200);
  });

  it('skips corrupt lumps instead of throwing', async () => {
    const corrupt = await parsePakFile(
      pakFile([{ name: 'pics/colormap.pcx', data: new ArrayBuffer(10) }]),
    );
    expect(resolveColormapPcx([corrupt])).toBeNull();
  });
});

describe('viewer sky stand-in (light grey)', () => {
  function grayPalette(): Uint8Array {
    const pal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      pal[i * 3] = i;
      pal[i * 3 + 1] = i;
      pal[i * 3 + 2] = i;
    }
    return pal;
  }

  it('returns null without a usable palette', async () => {
    const { buildGreySkyStrip } = await import('./loader.js');
    expect(buildGreySkyStrip(null)).toBeNull();
    expect(buildGreySkyStrip(new Uint8Array(10))).toBeNull();
  });

  it('builds a flat valid strip at the palette entry nearest light grey', async () => {
    const { buildGreySkyStrip } = await import('./loader.js');
    const grey = buildGreySkyStrip(grayPalette());
    expect(grey).not.toBeNull();
    expect(grey!.width).toBe(4);
    expect(grey!.height).toBe(6);
    expect(grey!.texels.length).toBe(24);
    // Gray ramp: nearest to (224,224,224) is index 224, flat across the strip.
    expect(grey!.texels[0]).toBe(224);
    for (const t of grey!.texels) expect(t).toBe(224);
  });
});
