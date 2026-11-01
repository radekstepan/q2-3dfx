// apps/web/src/map-viewer/panel.test.ts — inspection panel (plan §4).
// Synthetic data only: a minimal hand-built BSP38 (entities + one model)
// through the real loadBsp, plus a FakeDocument. No proprietary assets.
import { describe, expect, it, afterEach } from 'vitest';
import { loadBsp } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import { parseEntities } from '@q2/game';
import { ingestPak, readPakEntry } from '../pak.js';
import {
  PLAYER_START_CLASS,
  classifyEntities,
  createPanel,
  entityMarkers,
  filterEntities,
  mapStats,
  parseOrigin,
  unsupportedEntities,
} from './panel.js';

type Listener = (e?: unknown) => void;

class FakeElement {
  children: FakeElement[] = [];
  listeners = new Map<string, Listener[]>();
  className = '';
  textContent = '';
  value = '';
  type = '';
  checked = false;
  disabled = false;
  readOnly = false;
  placeholder = '';
  title = '';
  attrs = new Map<string, string>();
  tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  appendChild(child: FakeElement): void {
    this.children.push(child);
  }
  remove(): void {
    // Detach is a no-op for the fake; presence in children is what tests read.
  }
  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  set innerHTML(_v: string) {
    this.children = [];
  }
  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn({});
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({});
  }
}

class FakeDocument {
  created: FakeElement[] = [];
  body: FakeElement = new FakeElement('body');
  createElement(tag: string): FakeElement {
    const e = new FakeElement(tag);
    this.created.push(e);
    return e;
  }
  querySelector(_sel: string): null {
    return null;
  }
}

function install(): { doc: FakeDocument; prev: unknown } {
  const g = globalThis as unknown as { document?: unknown };
  const prev = g.document;
  const doc = new FakeDocument();
  g.document = doc;
  return { doc, prev };
}

afterEach(() => {
  const g = globalThis as unknown as { document?: unknown };
  if (g.document instanceof FakeDocument) g.document = undefined;
});

/** Minimal valid BSP38: header + entities lump + one 48-byte model. */
function makeBsp(
  entitiesText: string,
  mins: [number, number, number] = [-144, -144, -16],
  maxs: [number, number, number] = [176, 176, 240],
): BspMap {
  const entBytes = new TextEncoder().encode(entitiesText);
  const header = 8 + 19 * 8;
  const entOfs = header;
  const modelOfs = entOfs + entBytes.length;
  const buf = new ArrayBuffer(modelOfs + 48);
  const view = new DataView(buf);
  view.setInt32(0, 0x50534249, true); // "IBSP"
  view.setInt32(4, 38, true);
  const setLump = (i: number, ofs: number, len: number): void => {
    view.setInt32(8 + i * 8, ofs, true);
    view.setInt32(8 + i * 8 + 4, len, true);
  };
  for (let i = 0; i < 19; i++) setLump(i, 0, 0);
  setLump(0, entOfs, entBytes.length);
  setLump(13, modelOfs, 48);
  new Uint8Array(buf).set(entBytes, entOfs);
  const f = (o: number, v: number): void => view.setFloat32(modelOfs + o, v, true);
  f(0, mins[0]);
  f(4, mins[1]);
  f(8, mins[2]);
  f(12, maxs[0]);
  f(16, maxs[1]);
  f(20, maxs[2]);
  return loadBsp(buf);
}

const FIXTURE_ENTITIES = `{
"classname" "worldspawn"
"message" "fixture"
}
{
"classname" "info_player_start"
"origin" "0 -64 8"
"angle" "90"
}
{
"classname" "light"
"origin" "64 0 112"
"light" "300"
}
{
"classname" "func_door"
"model" "*1"
}
{
"classname" "light"
"origin" "bogus"
"light" "250"
}
`;

describe('parseOrigin', () => {
  it('parses three finite numbers', () => {
    expect(parseOrigin('0 -64 8')).toEqual([0, -64, 8]);
    expect(parseOrigin('  1.5  2.5  -3.25 ')).toEqual([1.5, 2.5, -3.25]);
  });
  it('rejects missing, short, long, and non-numeric origins', () => {
    expect(parseOrigin(undefined)).toBeNull();
    expect(parseOrigin('')).toBeNull();
    expect(parseOrigin('1 2')).toBeNull();
    expect(parseOrigin('1 2 3 4')).toBeNull();
    expect(parseOrigin('bogus')).toBeNull();
    expect(parseOrigin('1 two 3')).toBeNull();
    expect(parseOrigin('1 2 nan')).toBeNull();
    expect(parseOrigin('1 2 Infinity')).toBeNull();
  });
});

describe('entity classification', () => {
  const dicts = parseEntities(FIXTURE_ENTITIES);
  it('parses five fixture entities', () => {
    expect(dicts).toHaveLength(5);
  });
  it('marks point entities with usable origins, player start flagged', () => {
    const out = classifyEntities(dicts);
    expect(out).toHaveLength(5);
    expect(out[1]!.status).toBe('marker');
    expect(out[1]!.playerStart).toBe(true);
    expect(out[1]!.classname).toBe(PLAYER_START_CLASS);
    expect(out[1]!.origin).toEqual([0, -64, 8]);
    expect(out[2]!.status).toBe('marker');
    expect(out[2]!.playerStart).toBe(false);
  });
  it('never places misleading markers for unsupported entities', () => {
    const out = classifyEntities(dicts);
    expect(out[0]!.status).toBe('no-origin'); // worldspawn
    expect(out[3]!.status).toBe('brush-no-origin'); // func_door *1
    expect(out[4]!.status).toBe('bad-origin'); // malformed light
    expect(entityMarkers(out).map((e) => e.index)).toEqual([1, 2]);
    // Player starts sort first among markers.
    expect(entityMarkers(out)[0]!.playerStart).toBe(true);
    expect(unsupportedEntities(out).map((e) => e.index)).toEqual([0, 3, 4]);
  });
  it('defaults missing classnames to noclass instead of crashing', () => {
    const out = classifyEntities([{}]);
    expect(out[0]!.classname).toBe('noclass');
    expect(out[0]!.status).toBe('no-origin');
  });
  it('tolerates garbage entity text without throwing', () => {
    expect(() => classifyEntities(parseEntities('{{{ [[['))).not.toThrow();
    expect(() => classifyEntities(parseEntities(''))).not.toThrow();
    expect(classifyEntities(parseEntities(''))).toEqual([]);
  });
});

describe('filterEntities', () => {
  const out = classifyEntities(parseEntities(FIXTURE_ENTITIES));
  it('matches classname substrings case-insensitively', () => {
    expect(filterEntities(out, 'light').map((e) => e.index)).toEqual([2, 4]);
    expect(filterEntities(out, 'LIGHT')).toHaveLength(2);
    expect(filterEntities(out, 'info_player')).toHaveLength(1);
    expect(filterEntities(out, '')).toHaveLength(5);
    expect(filterEntities(out, '   ')).toHaveLength(5);
    expect(filterEntities(out, 'zzz')).toHaveLength(0);
  });
});

describe('mapStats', () => {
  it('reports lump counts, parsed entity count, and world-model bounds', () => {
    const bsp = makeBsp(FIXTURE_ENTITIES);
    const stats = mapStats(bsp);
    expect(stats.faces).toBe(0);
    expect(stats.brushes).toBe(0);
    expect(stats.leaves).toBe(0);
    expect(stats.models).toBe(1);
    expect(stats.entities).toBe(5);
    expect(stats.bounds).toEqual({ mins: [-144, -144, -16], maxs: [176, 176, 240] });
    expect(stats.entityLumpChars).toBe(FIXTURE_ENTITIES.length);
  });
});

describe('createPanel', () => {
  it('renders stats, filters, selects, and goes to a player start', () => {
    install();
    const root = new FakeElement('div') as unknown as HTMLElement;
    const seen: Array<[number, number, number]> = [];
    const panel = createPanel(root, { onGotoEntity: (origin) => seen.push(origin) });
    panel.setMap(makeBsp(FIXTURE_ENTITIES), 'maps/fixture.bsp');

    // Stats mention counts and bounds.
    const statsText = (panel.element.children[1]!.children[0]! as unknown as FakeElement).children
      .map((c) => c.textContent)
      .join('\n');
    expect(statsText).toContain('entities 5');
    expect(statsText).toContain('bounds mins');

    // Markers: 2 usable, 3 unsupported.
    expect(panel.markerEntries().map((e) => e.index)).toEqual([1, 2]);
    expect(panel.unsupportedEntries()).toHaveLength(3);

    // Filter narrows the visible list.
    expect(panel.applyFilter('light')).toBe(2);
    expect(panel.visibleEntries().map((e) => e.index)).toEqual([2, 4]);
    expect(panel.applyFilter('')).toBe(5);

    // Select the player start, inspect keys, go to its origin.
    expect(panel.selectEntity(1)).toBe(true);
    expect(panel.selectedIndex()).toBe(1);
    expect(panel.gotoSelected()).toBe(true);
    expect(seen).toEqual([[0, -64, 8]]);

    // Unsupported entity: selectable for key inspection, but no go-to.
    expect(panel.selectEntity(3)).toBe(true);
    expect(panel.gotoSelected()).toBe(false);
    expect(seen).toHaveLength(1);

    // Unknown index selects nothing.
    expect(panel.selectEntity(99)).toBe(false);
  });

  it('toggles markers and copies the view with map + pose metadata', async () => {
    install();
    const root = new FakeElement('div') as unknown as HTMLElement;
    const toggles: boolean[] = [];
    const copied: string[] = [];
    const panel = createPanel(root, {
      camera: {
        toCopyable: () => 'origin (0 -64 32) angles (0 90 0)',
        fromCopyable: () => true,
        reset: () => {},
      },
      clipboard: { writeText: async (t: string) => void copied.push(t) },
      onMarkersToggle: (on: boolean) => void toggles.push(on),
    });
    panel.setMap(makeBsp(FIXTURE_ENTITIES), 'maps/fixture.bsp');
    expect(panel.markersEnabled()).toBe(true);

    // Flip the markers checkbox (second child of the markers row).
    const markersRow = panel.element.children[1]!.children[1]! as unknown as FakeElement;
    const checkbox = markersRow.children[0]!.children[0]! as unknown as FakeElement;
    checkbox.checked = false;
    checkbox.fire('change');
    expect(panel.markersEnabled()).toBe(false);
    expect(toggles).toEqual([false]);

    const payload = await panel.copyView();
    expect(payload).toBe('map: maps/fixture.bsp\npose: origin (0 -64 32) angles (0 90 0)');
    expect(copied).toEqual([payload]);
  });

  it('applies typed coordinates and resets through the attached camera', () => {
    install();
    const root = new FakeElement('div') as unknown as HTMLElement;
    const applied: string[] = [];
    let resets = 0;
    const panel = createPanel(root, {
      camera: {
        toCopyable: () => 'origin (0 0 0) angles (0 0 0)',
        // Shell-shaped cameras only accept the bare `origin x y z; angles …`
        // spelling: the panel must try it before the parenthesized form.
        fromCopyable: (t: string) => {
          if (t.includes('(')) return false;
          applied.push(t);
          return true;
        },
        reset: () => void resets++,
      },
      clipboard: null,
    });
    panel.setMap(makeBsp(FIXTURE_ENTITIES), 'maps/fixture.bsp');

    const camBox = panel.element.children[1]!.children[5]! as unknown as FakeElement;
    const [originIn, anglesIn] = camBox.children.slice(1, 3) as unknown as FakeElement[];
    originIn.value = '0 -64 32';
    anglesIn.value = '0 90 0';
    expect(panel.applyCameraInputs()).toBe(true);
    expect(applied).toEqual(['origin 0 -64 32; angles 0 90 0']);

    originIn.value = 'bogus';
    expect(panel.applyCameraInputs()).toBe(false);
    panel.resetCamera();
    expect(resets).toBe(1);
  });

  it('reports cleanly with no camera attached', async () => {
    install();
    const root = new FakeElement('div') as unknown as HTMLElement;
    const panel = createPanel(root, { clipboard: null });
    panel.setMap(makeBsp(FIXTURE_ENTITIES), 'maps/fixture.bsp');
    // No throw; boolean/empty results signal the missing shell camera.
    expect(panel.applyCameraInputs()).toBe(false);
    expect(await panel.copyView()).toBe('');
    expect(() => panel.resetCamera()).not.toThrow();
    expect(panel.gotoSelected()).toBe(false);
  });

  it('reset is optional on the camera (shell owns spawn/bounds reset)', () => {
    install();
    const root = new FakeElement('div') as unknown as HTMLElement;
    const panel = createPanel(root, {
      camera: { toCopyable: () => '', fromCopyable: () => false },
      clipboard: null,
    });
    panel.setMap(makeBsp(FIXTURE_ENTITIES), 'maps/fixture.bsp');
    expect(() => panel.resetCamera()).not.toThrow();
  });

  it('reloads repeatedly without stale entities (synthetic fixture)', () => {
    install();
    const root = new FakeElement('div') as unknown as HTMLElement;
    const panel = createPanel(root, {});
    panel.setMap(makeBsp(FIXTURE_ENTITIES), 'maps/a.bsp');
    expect(panel.markerEntries()).toHaveLength(2);
    expect(panel.selectEntity(1)).toBe(true);

    const smaller = `{\n"classname" "worldspawn"\n}\n`;
    panel.setMap(makeBsp(smaller, [0, 0, 0], [64, 64, 64]), 'maps/b.bsp');
    expect(panel.markerEntries()).toHaveLength(0);
    expect(panel.selectedIndex()).toBeNull();
    expect(mapStats(makeBsp(smaller)).entities).toBe(1);

    panel.setMap(null);
    expect(panel.markerEntries()).toHaveLength(0);
    expect(panel.visibleEntries()).toHaveLength(0);
  });

  it('accepts the shell call shape createPanel(root, { bsp, name }) and disposes', () => {
    install();
    const root = new FakeElement('div') as unknown as HTMLElement;
    const panel = createPanel(root, { bsp: makeBsp(FIXTURE_ENTITIES), name: 'maps/direct.bsp' });
    expect(panel.markerEntries()).toHaveLength(2);
    expect(panel.selectedIndex()).toBeNull();
    panel.dispose();
    expect((root as unknown as FakeElement).children).toHaveLength(0);
    expect(panel.markerEntries()).toHaveLength(0);
  });

  it('collapses and expands the panel body', () => {
    install();
    const root = new FakeElement('div') as unknown as HTMLElement;
    const panel = createPanel(root, {});
    const head = panel.element.children[0]! as unknown as FakeElement;
    const body = panel.element.children[1]! as unknown as FakeElement;
    expect(body.getAttribute('hidden')).toBeNull();
    head.children[0]!.click();
    expect(body.getAttribute('hidden')).toBe('');
    head.children[0]!.click();
    expect(body.getAttribute('hidden')).toBeNull();
  });
});

const WEB_Q2_PAK = process.env.Q2_PAK;

describe.runIf(!!WEB_Q2_PAK)('panel against a real base1 (Q2_PAK)', () => {
  it('locates the player start and reports real lump counts', async () => {
    install();
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const pak = ingestPak(buf);
    const bspBytes = readPakEntry(pak, 'maps/base1.bsp');
    const bsp = loadBsp(bspBytes);
    const stats = mapStats(bsp);
    expect(stats.faces).toBeGreaterThan(0);
    expect(stats.entities).toBeGreaterThan(0);
    expect(stats.bounds).not.toBeNull();
    const classified = classifyEntities(parseEntities(bsp.entities));
    const starts = classified.filter((e) => e.playerStart && e.status === 'marker');
    expect(starts.length).toBeGreaterThan(0);
    for (const s of starts) expect(s.origin).not.toBeNull();

    const root = new FakeElement('div') as unknown as HTMLElement;
    const panel = createPanel(root, {});
    panel.setMap(bsp, 'maps/base1.bsp');
    expect(panel.markerEntries().length).toBeGreaterThan(0);
  });
});
