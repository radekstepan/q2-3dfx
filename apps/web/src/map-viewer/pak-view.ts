// apps/web map-viewer pak-view: pure PAK map-listing + asset-precedence helpers.
//
// DOM-free so loader tests stay headless. Entry names follow pak.ts: they are
// lowercased at ingest, so all matching here is exact-lowercase.

import type { WebPak } from '../pak.js';

/** Map lumps live under maps/ and end in .bsp (Quake II convention). */
export function isMapEntry(name: string): boolean {
  return name.startsWith('maps/') && name.endsWith('.bsp');
}

/** Sorted maps/*.bsp entry names in a PAK (ingest-lowercased, deduped). */
export function listPakMaps(pak: WebPak): string[] {
  const out: string[] = [];
  for (const e of pak.entries) {
    if (isMapEntry(e.name) && !out.includes(e.name)) out.push(e.name);
  }
  return out.sort();
}

/** Display name for a maps/*.bsp lump: strips the directory and extension. */
export function shortMapName(path: string): string {
  const slash = path.lastIndexOf('/');
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  return base.endsWith('.bsp') ? base.slice(0, -'.bsp'.length) : base;
}

/** One loaded asset PAK slot: label is the user-visible file name. */
export interface AssetPakSlot {
  label: string;
  pak: WebPak;
}

/** Human-readable precedence list. First-listed PAK wins texture/palette ties. */
export function describePrecedence(slots: AssetPakSlot[]): string {
  if (slots.length === 0) return 'no asset PAKs (checker/procedural fallbacks)';
  return slots
    .map((s, i) => `${i + 1}. ${s.label}${i === 0 ? ' (wins ties)' : ''}`)
    .join('\n');
}

/** One-line PAK summary for the status area. */
export function summarizePak(pak: WebPak): string {
  const maps = listPakMaps(pak);
  const hasPalette = pak.entries.some((e) => e.name === 'pics/colormap.pcx');
  return (
    `${pak.entries.length} entries, ${maps.length} map(s)` +
    `${hasPalette ? ', palette present' : ', no palette'}`
  );
}
