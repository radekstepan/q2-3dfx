// apps/web/src/map-viewer/panel.ts — collapsible map inspection panel (plan §4).
//
// Stats (bounds + lump counts), searchable entity list, entity markers toggle
// (player starts distinguished; brush entities without usable origins are
// reported as unsupported, never given misleading markers), and camera
// controls (reset / enter coords+angles / copy view).
//
// The viewer shell owns loading, rendering, and the camera. This module never
// imports the shell: the camera is an optional structural dependency
// (PanelCamera mirrors toCopyable/fromCopyable/reset) and navigation is a
// callback. Malformed entity lumps degrade to an empty list with a note.
// Top-down overview is a deferred follow-up (see docs/map-viewer.md).

import { lumpCounts } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import { parseEntities } from '@q2/game';
import type { EntDict } from '@q2/game';
import { captureMetadataText, formatPoseText, parsePoseText } from './capture.js';
import type { ClipboardLike } from './capture.js';
import type { ViewPose } from './capture.js';

export type { ViewPose };
export type { ClipboardLike };

/** Player-start classname, distinguished in the list and markers. */
export const PLAYER_START_CLASS = 'info_player_start';

/** Map statistics derived from the loaded BSP. */
export interface MapStatsData {
  faces: number;
  brushes: number;
  leaves: number;
  models: number;
  /** Entity count from the parsed entity lump (not lump byte length). */
  entities: number;
  /** World-model (index 0) bounds; null when the map has no models. */
  bounds: { mins: [number, number, number]; maxs: [number, number, number] } | null;
  /** Raw entity lump length in characters (diagnostic for empty/truncated lumps). */
  entityLumpChars: number;
}

/** Stats for the panel: lump counts plus world-model bounds. Never throws. */
export function mapStats(bsp: BspMap): MapStatsData {
  const counts = lumpCounts(bsp);
  let entities = 0;
  try {
    entities = parseEntities(typeof bsp.entities === 'string' ? bsp.entities : '').length;
  } catch {
    entities = 0;
  }
  let bounds: MapStatsData['bounds'] = null;
  if (bsp.modelsMins.length >= 3 && bsp.modelsMaxs.length >= 3) {
    bounds = {
      mins: [bsp.modelsMins[0]!, bsp.modelsMins[1]!, bsp.modelsMins[2]!],
      maxs: [bsp.modelsMaxs[0]!, bsp.modelsMaxs[1]!, bsp.modelsMaxs[2]!],
    };
  }
  return {
    faces: counts['faces'] ?? 0,
    brushes: counts['brushes'] ?? 0,
    leaves: counts['leafs'] ?? 0,
    models: counts['models'] ?? 0,
    entities,
    bounds,
    entityLumpChars: typeof bsp.entities === 'string' ? bsp.entities.length : 0,
  };
}

/**
 * Strict origin parse: exactly three finite numbers. Returns null for
 * missing keys, wrong arity, or non-numeric parts (malformed entities
 * degrade gracefully instead of placing markers at the origin).
 */
export function parseOrigin(value: string | undefined): [number, number, number] | null {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const nums = parts.map(Number);
  if (nums.some((v) => !Number.isFinite(v))) return null;
  return [nums[0]!, nums[1]!, nums[2]!];
}

/** Why an entity does or does not get a marker. */
export type EntityMarkerStatus =
  | 'marker' // usable origin: eligible for a marker + "go to"
  | 'brush-no-origin' // brush model (*N) with no origin: static submodel, no meaningful point
  | 'bad-origin' // has an origin key but it does not parse
  | 'no-origin'; // point entity without an origin key

export interface ClassifiedEntity {
  index: number;
  classname: string;
  dict: EntDict;
  origin: [number, number, number] | null;
  status: EntityMarkerStatus;
  playerStart: boolean;
}

/** Classify every entity dict; never throws on malformed input. */
export function classifyEntities(dicts: EntDict[]): ClassifiedEntity[] {
  return dicts.map((dict, index) => {
    const raw = dict['classname'];
    const classname = typeof raw === 'string' && raw !== '' ? raw : 'noclass';
    const hasOriginKey = Object.prototype.hasOwnProperty.call(dict, 'origin');
    const origin = parseOrigin(dict['origin']);
    const model = dict['model'];
    const brushModel = typeof model === 'string' && model.startsWith('*');
    let status: EntityMarkerStatus;
    if (origin) status = 'marker';
    else if (brushModel && !hasOriginKey) status = 'brush-no-origin';
    else if (hasOriginKey) status = 'bad-origin';
    else status = 'no-origin';
    return { index, classname, dict, origin, status, playerStart: classname === PLAYER_START_CLASS };
  });
}

/** Entities with usable origins (marker-eligible). Player starts first. */
export function entityMarkers(classified: ClassifiedEntity[]): ClassifiedEntity[] {
  return classified
    .filter((e) => e.status === 'marker')
    .sort((a, b) => Number(b.playerStart) - Number(a.playerStart) || a.index - b.index);
}

/** Entities without markers, with reasons (shown as unsupported, not placed). */
export function unsupportedEntities(classified: ClassifiedEntity[]): ClassifiedEntity[] {
  return classified.filter((e) => e.status !== 'marker');
}

/** Case-insensitive classname substring filter; empty query matches all. */
export function filterEntities(classified: ClassifiedEntity[], query: string): ClassifiedEntity[] {
  const q = (query ?? '').trim().toLowerCase();
  if (q === '') return classified;
  return classified.filter((e) => e.classname.toLowerCase().includes(q));
}

/**
 * Structural camera dependency (mirrors the shell camera; the shell owns it).
 * reset is optional: the sibling shell camera exposes spawn/bounds resets
 * instead, so the panel degrades to a status note when it is absent.
 */
export interface PanelCamera {
  toCopyable(): string;
  fromCopyable(text: string): boolean;
  reset?(): void;
}

export interface PanelOptions {
  camera?: PanelCamera | null;
  /** Clipboard sink; null disables clipboard attempts. Defaults to navigator.clipboard. */
  clipboard?: ClipboardLike | null;
  /** "Go to" navigation (shell moves its camera). Absent → status note. */
  onGotoEntity?: (origin: [number, number, number], index: number) => void;
  onMarkersToggle?: (enabled: boolean) => void;
  onSelectEntity?: (entry: ClassifiedEntity) => void;
  /** Pose text applied with camera.fromCopyable when no camera is attached. */
  onApplyPose?: (pose: ViewPose) => void;
  /** Fallback pose source for copy-view when no camera is attached. */
  getPose?: () => ViewPose | null;
}

export interface PanelHandle {
  element: HTMLElement;
  setMap(bsp: BspMap | null, name?: string): void;
  attachCamera(camera: PanelCamera | null): void;
  setPoseProvider(fn: (() => ViewPose | null) | null): void;
  markersEnabled(): boolean;
  markerEntries(): ClassifiedEntity[];
  unsupportedEntries(): ClassifiedEntity[];
  visibleEntries(): ClassifiedEntity[];
  selectedIndex(): number | null;
  selectEntity(index: number): boolean;
  applyFilter(query: string): number;
  gotoSelected(): boolean;
  copyView(): Promise<string>;
  applyCameraInputs(): boolean;
  resetCamera(): void;
  /** Tear down panel state and clear the root (map-switch path). */
  dispose(): void;
}

/** Minimal map shape for the direct-call form (mirrors the shell LoadedMap). */
export interface PanelMapLike {
  bsp: BspMap;
  name?: string;
}

function isMapLike(value: unknown): value is PanelMapLike {
  if (typeof value !== 'object' || value === null) return false;
  const bsp = (value as { bsp?: unknown }).bsp;
  return typeof bsp === 'object' && bsp !== null;
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node as unknown as HTMLElement;
}

function fmtN(v: number): string {
  const rounded = Math.round(v * 10) / 10;
  return `${rounded < 0 ? '−' : ''}${Math.abs(rounded)}`;
}

function fmtVec(v: [number, number, number]): string {
  return `(${v.map(fmtN).join(' ')})`;
}

function ambientClipboard(): ClipboardLike | null {
  try {
    const nav = (globalThis as unknown as { navigator?: { clipboard?: ClipboardLike } }).navigator;
    return nav?.clipboard ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the collapsible inspection panel inside `root` (cleared first).
 * Headless-safe: only `document.createElement` is used, so the FakeDocument
 * pattern from the web test suite applies.
 *
 * Second argument is either PanelOptions or a loaded-map-like
 * `{ bsp, name? }` (the viewer shell calls `createPanel(root, loadedMap)`);
 * a map-like argument shows that map immediately.
 */
export function createPanel(root: HTMLElement, mapOrOpts?: PanelOptions | PanelMapLike): PanelHandle {
  const asMap = isMapLike(mapOrOpts) ? mapOrOpts : null;
  const options: PanelOptions = !isMapLike(mapOrOpts) && mapOrOpts ? mapOrOpts : {};
  let camera: PanelCamera | null = options.camera ?? null;
  let poseProvider: (() => ViewPose | null) | null = options.getPose ?? null;
  let mapName = '';
  let classified: ClassifiedEntity[] = [];
  let parseError: string | null = null;
  let filterQuery = '';
  let selected: number | null = null;
  let markersOn = true;

  root.innerHTML = '';
  const wrap = el('div', 'q2-map-panel');
  root.appendChild(wrap);

  const header = el('div', 'q2-map-panel-head');
  const toggle = el('button', 'q2-map-panel-toggle', 'Inspection ▾') as unknown as HTMLButtonElement;
  const nameSpan = el('span', 'q2-map-panel-name', 'no map');
  header.appendChild(toggle);
  header.appendChild(nameSpan);
  wrap.appendChild(header);

  const body = el('div', 'q2-map-panel-body');
  wrap.appendChild(body);

  toggle.addEventListener('click', () => {
    const hidden = body.getAttribute('hidden') !== null;
    if (hidden) {
      body.removeAttribute('hidden');
      toggle.textContent = 'Inspection ▾';
    } else {
      body.setAttribute('hidden', '');
      toggle.textContent = 'Inspection ▸';
    }
  });

  // --- stats ---
  const statsBox = el('div', 'q2-map-panel-stats');
  body.appendChild(statsBox);

  // --- markers toggle ---
  const markersRow = el('div', 'q2-map-panel-markers');
  const markersLabel = el('label', undefined, 'Entity markers ') as unknown as HTMLLabelElement;
  const markersBox = el('input') as unknown as HTMLInputElement;
  markersBox.type = 'checkbox';
  markersBox.checked = true;
  markersLabel.appendChild(markersBox as unknown as HTMLElement);
  const markersNote = el('span', 'q2-map-panel-note', '');
  markersRow.appendChild(markersLabel);
  markersRow.appendChild(markersNote);
  body.appendChild(markersRow);

  markersBox.addEventListener('change', () => {
    markersOn = markersBox.checked;
    options.onMarkersToggle?.(markersOn);
    renderList();
  });

  // --- entity search + list ---
  const searchBox = el('input') as unknown as HTMLInputElement;
  searchBox.type = 'search';
  searchBox.placeholder = 'filter classname…';
  searchBox.title = 'Filter entities by classname';
  body.appendChild(searchBox as unknown as HTMLElement);

  const listBox = el('div', 'q2-map-panel-list');
  body.appendChild(listBox);

  searchBox.addEventListener('input', () => {
    filterQuery = searchBox.value;
    if (selected !== null && !visibleEntries().some((e) => e.index === selected)) selected = null;
    renderList();
    renderDetail();
  });

  // --- detail ---
  const detailBox = el('div', 'q2-map-panel-detail');
  body.appendChild(detailBox);

  // --- camera controls ---
  const camBox = el('div', 'q2-map-panel-camera');
  const originInput = el('input') as unknown as HTMLInputElement;
  originInput.placeholder = 'origin x y z';
  originInput.title = 'Camera origin, e.g. 0 -64 32';
  const anglesInput = el('input') as unknown as HTMLInputElement;
  anglesInput.placeholder = 'angles p y r';
  anglesInput.title = 'Camera angles [pitch, yaw, roll], e.g. 0 90 0';
  const applyBtn = el('button', undefined, 'Apply view') as unknown as HTMLButtonElement;
  const resetBtn = el('button', undefined, 'Reset camera') as unknown as HTMLButtonElement;
  const copyBtn = el('button', undefined, 'Copy view') as unknown as HTMLButtonElement;
  const copyOut = el('input') as unknown as HTMLInputElement;
  copyOut.readOnly = true;
  copyOut.title = 'Copyable pose text (manual fallback when clipboard is unavailable)';
  const camStatus = el('div', 'q2-map-panel-status', '');
  camBox.appendChild(el('div', 'q2-map-panel-title', 'Camera'));
  camBox.appendChild(originInput as unknown as HTMLElement);
  camBox.appendChild(anglesInput as unknown as HTMLElement);
  camBox.appendChild(applyBtn as unknown as HTMLElement);
  camBox.appendChild(resetBtn as unknown as HTMLElement);
  camBox.appendChild(copyBtn as unknown as HTMLElement);
  camBox.appendChild(copyOut as unknown as HTMLElement);
  camBox.appendChild(camStatus);
  body.appendChild(camBox);

  function setStatus(text: string): void {
    camStatus.textContent = text;
  }

  function visibleEntries(): ClassifiedEntity[] {
    return filterEntities(classified, filterQuery);
  }

  function renderStats(bsp: BspMap | null): void {
    statsBox.innerHTML = '';
    if (!bsp) {
      statsBox.appendChild(el('div', undefined, 'No map loaded.'));
      return;
    }
    const stats = mapStats(bsp);
    const lines = [
      `faces ${stats.faces} · brushes ${stats.brushes} · leaves ${stats.leaves} · models ${stats.models} · entities ${stats.entities}`,
      stats.bounds
        ? `bounds mins ${fmtVec(stats.bounds.mins)} maxs ${fmtVec(stats.bounds.maxs)}`
        : 'bounds unavailable (map has no models)',
    ];
    if (parseError) lines.push(`entity lump unreadable: ${parseError}`);
    else if (stats.entities === 0) lines.push(`entity lump holds no entities (${stats.entityLumpChars} chars)`);
    for (const line of lines) statsBox.appendChild(el('div', undefined, line));
  }

  function entryLabel(e: ClassifiedEntity): string {
    const tag = e.playerStart ? '[start] ' : '';
    const at = e.origin ? ` @ ${fmtVec(e.origin)}` : ` (${e.status})`;
    return `#${e.index} ${tag}${e.classname}${at}`;
  }

  function renderList(): void {
    listBox.innerHTML = '';
    const unsupported = unsupportedEntities(classified);
    markersNote.textContent =
      `${entityMarkers(classified).length} markers` +
      (unsupported.length > 0 ? ` · ${unsupported.length} unsupported (no marker placed)` : '') +
      (markersOn ? '' : ' · hidden');
    for (const e of visibleEntries()) {
      const btn = el('button', 'q2-map-panel-entry', entryLabel(e)) as unknown as HTMLButtonElement;
      if (e.index === selected) btn.setAttribute('data-selected', 'true');
      if (e.status !== 'marker') btn.setAttribute('data-unsupported', e.status);
      btn.addEventListener('click', () => selectEntity(e.index));
      listBox.appendChild(btn as unknown as HTMLElement);
    }
    if (visibleEntries().length === 0) {
      listBox.appendChild(el('div', 'q2-map-panel-note', classified.length === 0 ? 'No entities.' : 'No entities match the filter.'));
    }
  }

  function renderDetail(): void {
    detailBox.innerHTML = '';
    const entry = selected !== null ? classified.find((e) => e.index === selected) ?? null : null;
    if (!entry) {
      detailBox.appendChild(el('div', 'q2-map-panel-note', 'Select an entity to inspect its keys.'));
      return;
    }
    detailBox.appendChild(el('div', 'q2-map-panel-title', `#${entry.index} ${entry.classname}`));
    const keys = Object.keys(entry.dict).sort();
    for (const key of keys) {
      detailBox.appendChild(el('div', undefined, `${key} = ${entry.dict[key]}`));
    }
    if (entry.status !== 'marker') {
      detailBox.appendChild(el('div', 'q2-map-panel-note', `No marker: ${entry.status}.`));
    }
    if (entry.origin) {
      const go = el('button', undefined, 'Go to') as unknown as HTMLButtonElement;
      go.addEventListener('click', () => gotoSelected());
      detailBox.appendChild(go as unknown as HTMLElement);
    }
  }

  function renderAll(bsp: BspMap | null): void {
    nameSpan.textContent = mapName === '' ? 'no map' : mapName;
    renderStats(bsp);
    renderList();
    renderDetail();
  }

  function selectEntity(index: number): boolean {
    const entry = classified.find((e) => e.index === index) ?? null;
    if (!entry) return false;
    selected = index;
    options.onSelectEntity?.(entry);
    renderList();
    renderDetail();
    return true;
  }

  function gotoSelected(): boolean {
    const entry = selected !== null ? classified.find((e) => e.index === selected) ?? null : null;
    if (!entry || !entry.origin) {
      setStatus('Go to needs a selected entity with a usable origin.');
      return false;
    }
    if (!options.onGotoEntity) {
      setStatus('No navigation callback: the viewer shell owns camera movement.');
      return false;
    }
    options.onGotoEntity(entry.origin, entry.index);
    setStatus(`Going to #${entry.index} ${fmtVec(entry.origin)}.`);
    return true;
  }

  function currentPoseText(): string {
    if (camera) {
      try {
        return camera.toCopyable();
      } catch {
        return '';
      }
    }
    try {
      const pose = poseProvider?.() ?? null;
      return pose ? formatPoseText(pose) : '';
    } catch {
      return '';
    }
  }

  async function copyView(): Promise<string> {
    const text = currentPoseText();
    // Copy the full reproducing metadata (map + pose); fall back to the bare
    // pose when no map is loaded. The readonly field always shows exactly
    // what was copied so clipboard-denied browsers can copy it manually.
    const payload = text === '' ? '' : mapName === '' ? text : captureMetadataText(mapName, text);
    copyOut.value = payload;
    if (payload === '') {
      setStatus('No pose available to copy.');
      return '';
    }
    const sink = options.clipboard !== undefined ? options.clipboard : ambientClipboard();
    if (!sink) {
      setStatus('Clipboard unavailable — copy the pose text manually.');
      return payload;
    }
    try {
      await sink.writeText(payload);
      setStatus('View copied (map + pose metadata).');
    } catch {
      setStatus('Clipboard write failed — copy the pose text manually.');
    }
    return payload;
  }

  function applyCameraInputs(): boolean {
    const text = `origin (${originInput.value}) angles (${anglesInput.value})`;
    const pose = parsePoseText(text);
    if (!pose) {
      setStatus('Invalid coordinates: enter three numbers each for origin and angles.');
      return false;
    }
    if (camera) {
      // The camera owns its copyable format (shell: `origin x y z; angles
      // p y r`). fromCopyable is side-effect-free on reject, so try the
      // shell spelling first and the canonical fixture spelling second.
      const o = pose.origin.join(' ');
      const a = pose.angles.join(' ');
      let ok = false;
      for (const candidate of [`origin ${o}; angles ${a}`, formatPoseText(pose)]) {
        try {
          ok = camera.fromCopyable(candidate);
        } catch {
          ok = false;
        }
        if (ok) break;
      }
      setStatus(ok ? `View applied: ${formatPoseText(pose)}.` : 'Camera rejected the coordinates.');
      return ok;
    }
    if (options.onApplyPose) {
      options.onApplyPose(pose);
      setStatus(`View applied: ${formatPoseText(pose)}.`);
      return true;
    }
    setStatus('No camera attached: the viewer shell owns camera movement.');
    return false;
  }

  function resetCamera(): void {
    if (!camera || typeof camera.reset !== 'function') {
      setStatus('No shell reset attached: the viewer camera owns spawn/bounds reset.');
      return;
    }
    try {
      camera.reset();
      setStatus('Camera reset.');
    } catch {
      setStatus('Camera reset failed.');
    }
  }

  applyBtn.addEventListener('click', () => applyCameraInputs());
  resetBtn.addEventListener('click', () => resetCamera());
  copyBtn.addEventListener('click', () => void copyView());

  function dispose(): void {
    classified = [];
    parseError = null;
    selected = null;
    filterQuery = '';
    root.innerHTML = '';
  }

  const handle: PanelHandle = {
    element: wrap,
    dispose,
    setMap(bsp: BspMap | null, name?: string): void {
      mapName = name ?? (bsp ? mapName : '');
      classified = [];
      parseError = null;
      selected = null;
      if (bsp) {
        try {
          const dicts = parseEntities(typeof bsp.entities === 'string' ? bsp.entities : '');
          classified = classifyEntities(dicts);
        } catch (err) {
          parseError = err instanceof Error ? err.message : String(err);
          classified = [];
        }
      }
      renderAll(bsp);
    },
    attachCamera(next: PanelCamera | null): void {
      camera = next;
    },
    setPoseProvider(fn: (() => ViewPose | null) | null): void {
      poseProvider = fn;
    },
    markersEnabled: () => markersOn,
    markerEntries: () => entityMarkers(classified),
    unsupportedEntries: () => unsupportedEntities(classified),
    visibleEntries,
    selectedIndex: () => selected,
    selectEntity,
    applyFilter(query: string): number {
      filterQuery = query;
      searchBox.value = query;
      if (selected !== null && !visibleEntries().some((e) => e.index === selected)) selected = null;
      renderList();
      renderDetail();
      return visibleEntries().length;
    },
    gotoSelected,
    copyView,
    applyCameraInputs,
    resetCamera,
  };

  renderAll(null);
  if (asMap) handle.setMap(asMap.bsp, asMap.name);
  return handle;
}
