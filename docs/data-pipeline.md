# Data pipeline — pak to frame

> Extracted from BRAIN.md §8.

## 8. Data pipeline

```
pak0.pak ──PAK reader──┬─ maps/base1.bsp ──parseBSP38──┬─ planes, nodes, leafs, faces, texinfo
                       │                               ├─ lightmaps (RGB, 16-texel luxels)
                       │                               ├─ visibility (PVS/PHS, RLE)
                       │                               └─ entities (key/value lump)
                       ├─ textures/*.wal ──parseWAL────→ 4 mips of palette indices
                       ├─ pics/colormap.pcx ───────────→ 64×256 shade table + 256 palette
                       ├─ models/*.md2 ────────────────→ frames + st + tris
                       └─ sound/*.wav ─────────────────→ AudioBuffer
```

- **BSP38 lumps** (19): entities, planes, vertexes, visibility, nodes, texinfo, faces, lighting,
  leafs, leaffaces, leafbrushes, edges, surfedges, models, brushes, brushsides, pop, areas,
  areaportals. Parse into flat typed arrays (`Int32Array` of nodes, etc.) — **never** arrays of objects.
- **Cooking:** `tools/asset-cooker` converts a pak into `.q2pkg` (`Q2PKG1`: whole pak,
  per-file deflate + index, byte-identical round-trip). It does **not** split per map
  and nothing in the tree consumes `.q2pkg` yet — the web app ingests the dropped pak
  client-side and caches blobs in IndexedDB. Per-map subset streaming is future work,
  not a shipped path.
- **Caching:** `@q2/filesystem` stores cooked blobs in IndexedDB keyed by pak SHA-1.
- **Fallback:** if no pak is present, boot `maps/devroom` — the procedural room used by the demo page
  and the golden-frame tests. This keeps CI and the public demo asset-free. `maps/devroom`
  doubles as the demo1-era fallback (fixed cameras: `demoFallbackViews()` in `@q2/testkit`,
  `demoFallbackCameras()` in `apps/web/src/devroom.ts`); `demo1.dm2` itself can never ship —
  it is a recording of the retail `maps/base1` and playing it back needs the retail pak (§3).

