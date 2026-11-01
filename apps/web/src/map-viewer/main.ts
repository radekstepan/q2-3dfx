// apps/web map-viewer entry: standalone BSP viewer without gameplay.
// Owns page state: current LoadedMap, asset-PAK slots (first-listed wins),
// generation counter against stale async loads, viewer singletons
// (renderer + free camera + panel) and the frame-rate-independent render loop.

import { parseEntities } from '@q2/game';
import { parseMD2, parsePCX } from '@q2/formats';
import { collectEnemySpawns, summarizeEnemies } from './enemies.js';
import {
  buildGreySkyStrip,
  loadPakMap,
  loadStandaloneBsp,
  parsePakFile,
  resolveColormapPcx,
  resolveTexelFor,
} from './loader.js';
import type { LoadedMap } from './loader.js';
import { listPakMaps } from './pak-view.js';
import { describePrecedence } from './pak-view.js';
import type { AssetPakSlot } from './pak-view.js';
import type { WebPak } from '../pak.js';
import { readPakEntry } from '../pak.js';
import { createViewerRenderer } from './renderer.js';
import type { ViewerRenderer } from './renderer.js';
import { createFreeCamera } from './camera.js';
import type { FreeCamera } from './camera.js';
import { createPanel } from './panel.js';
import type { PanelHandle } from './panel.js';
import { captureViewerCanvas } from './capture.js';

let generation = 0;
let current: LoadedMap | null = null;
let assetSlots: AssetPakSlot[] = [];
let mapPak: { label: string; pak: WebPak } | null = null;
let renderer: ViewerRenderer | null = null;
let camera: FreeCamera | null = null;
let detachCamera: (() => void) | null = null;
let panelHandle: PanelHandle | null = null;
let rafId = 0;
let lastT = 0;
let loopRunning = false;
/** Installed engine palette (768-byte RGB) for sky remapping; persists like brightness. */
let lastPalette: Uint8Array | null = null;
/** Enemies toggle state; persists across map switches like brightness. */
let enemiesVisible = true;

function el<T extends HTMLElement>(id: string): T | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById(id) as T | null;
}

function status(lines: string[]): void {
  const node = el('mv-status');
  if (node) node.textContent = lines.join('\n');
}

function statusFor(map: LoadedMap): string[] {
  const head = `${map.name} · ${map.source}`;
  if (map.missingAssets.length === 0) return [head, 'all assets resolved'];
  return [head, `missing ${map.missingAssets.length}:`, ...map.missingAssets];
}

function worldBounds(map: LoadedMap): { mins: ArrayLike<number>; maxs: ArrayLike<number> } | null {
  try {
    const mins = map.bsp.modelsMins;
    const maxs = map.bsp.modelsMaxs;
    if (!mins || !maxs || mins.length < 3 || maxs.length < 3) return null;
    return {
      mins: [mins[0]!, mins[1]!, mins[2]!],
      maxs: [maxs[0]!, maxs[1]!, maxs[2]!],
    };
  } catch {
    return null;
  }
}

function ensureViewer(): boolean {
  if (typeof document === 'undefined') return false;
  if (renderer && camera && panelHandle) return true;
  const canvas = el<HTMLCanvasElement>('mv');
  const panelRoot = el('mv-panel');
  if (!canvas) return false;
  try {
    if (!renderer) renderer = createViewerRenderer(canvas);
    if (!camera) {
      camera = createFreeCamera({
        onLockChange: (locked) => {
          const hint = el('mv-hint');
          if (hint) {
            hint.textContent = locked
              ? 'pointer locked — WASD move · Space/C vertical · Shift fast · Esc releases'
              : 'click the canvas to capture mouse look (Esc releases) · WASD move · Space/C vertical · Shift fast';
          }
        },
      });
      detachCamera?.();
      try {
        detachCamera = camera.attach(canvas as never) ?? null;
      } catch {
        detachCamera = null;
      }
    }
    if (!panelHandle && panelRoot) {
      const cam: FreeCamera | null = camera;
      panelHandle = createPanel(panelRoot, {
        camera: cam
          ? {
              toCopyable: () => cam.toCopyable(),
              fromCopyable: (s: string) => cam.fromCopyable(s),
              reset: () => resetCameraToSpawn(),
            }
          : null,
        getPose: () =>
          cam
            ? {
                origin: [cam.pose.origin[0]!, cam.pose.origin[1]!, cam.pose.origin[2]!],
                angles: [cam.pose.angles[0]!, cam.pose.angles[1]!, cam.pose.angles[2]!],
              }
            : null,
        onGotoEntity: (origin) => {
          if (!cam) return;
          cam.pose.origin[0] = origin[0];
          cam.pose.origin[1] = origin[1];
          cam.pose.origin[2] = origin[2];
        },
      });
    }
  } catch (err) {
    status([`viewer init failed: ${err instanceof Error ? err.message : String(err)}`]);
    return false;
  }
  startLoop();
  return true;
}

function resetCameraToSpawn(): void {
  if (!camera) return;
  let dicts: Array<Record<string, string>> = [];
  if (current) {
    try {
      dicts = parseEntities(current.bsp.entities);
    } catch {
      dicts = [];
    }
  }
  const bounds = current ? worldBounds(current) : null;
  const used = camera.resetToSpawn(dicts, bounds as never);
  if (!used && bounds) camera.resetToBounds(bounds.mins, bounds.maxs);
}

/** Hide sky surfaces behind a flat very-light-grey fill so openings read
 * as contrast against the model (no sky art, no blue fallback). Needs the
 * installed palette (indices are palette-relative); without one the
 * engine's flat fallback stays. Returns a one-line status suffix. */
function installSky(): string {
  try {
    if (!renderer || !current) return 'sky: none (flat fallback)';
    if (lastPalette) {
      const grey = buildGreySkyStrip(lastPalette);
      if (grey) {
        renderer.setSkyTexture(grey);
        return 'sky: hidden (light-grey stand-in)';
      }
    }
    try {
      renderer.setSkyTexture(null);
    } catch {
      /* ignore */
    }
    return 'sky: flat fallback (no palette yet — add an asset PAK)';
  } catch {
    return 'sky: install failed (flat fallback)';
  }
}

/** PAKs searched for enemy MD2/PCX lumps: asset PAKs first, then the map's own PAK. */
function enemyPaks(): WebPak[] {
  const list = assetPaks();
  if (mapPak) list.push(mapPak.pak);
  return list;
}

/**
 * Install monster spawns as static MD2s at their BSP spawn poses (no
 * gameplay, no AI — a placement preview). Real MD2/PCX lumps resolve from
 * the asset + map PAKs first-wins; anything missing falls back to the
 * engine's procedural mesh/checker skin so spawns stay visible asset-free.
 * Returns a one-line status suffix. Never throws.
 */
function installEnemies(): string {
  try {
    if (!renderer || !current) return 'enemies: 0';
    let dicts: Array<Record<string, string>> = [];
    try {
      dicts = parseEntities(current.bsp.entities);
    } catch {
      dicts = [];
    }
    const spawns = collectEnemySpawns(dicts);
    const paks = enemyPaks();
    renderer.setEnemies(spawns, {
      md2For: (path: string) => {
        for (const pak of paks) {
          try {
            return parseMD2(readPakEntry(pak, path));
          } catch {
            continue;
          }
        }
        return null;
      },
      skinFor: (path: string) => {
        for (const pak of paks) {
          try {
            const pcx = parsePCX(readPakEntry(pak, path));
            return { pixels: pcx.pixels, width: pcx.width, height: pcx.height };
          } catch {
            continue;
          }
        }
        return null;
      },
    });
    try {
      renderer.setEnemiesVisible(enemiesVisible);
    } catch {
      /* keep installed list even if the toggle fails */
    }
    const summary = summarizeEnemies(spawns);
    return enemiesVisible ? summary : `${summary} (hidden)`;
  } catch {
    return 'enemies: install failed (world only)';
  }
}

function startLoop(): void {
  if (loopRunning || typeof window === 'undefined') return;
  loopRunning = true;
  lastT = performance.now();
  const tick = (now: number): void => {
    if (!loopRunning) return;
    rafId = window.requestAnimationFrame(tick);
    let dt = (now - lastT) / 1000;
    lastT = now;
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;
    try {
      if (camera) camera.update(dt, camera.readKeys());
      if (renderer && camera) {
        renderer.render(
          { origin: camera.pose.origin, angles: camera.pose.angles, fovX: 90 },
          now,
        );
      } else if (renderer) {
        renderer.render({ origin: [0, 0, 0], angles: [0, 0, 0], fovX: 90 }, now);
      }
    } catch {
      // Frame errors are surfaced by the renderer overlay; never kill the loop.
    }
  };
  rafId = window.requestAnimationFrame(tick);
}

function stopLoop(): void {
  loopRunning = false;
  try {
    if (typeof window !== 'undefined') window.cancelAnimationFrame(rafId);
  } catch {
    /* ignore */
  }
  rafId = 0;
}

/** Release map-specific state before showing another map (renderer kept, caches invalidated on setMap). */
function releaseMapState(): void {
  current = null;
}

async function showLoaded(map: LoadedMap, gen: number): Promise<void> {
  if (gen !== generation) return; // stale: a newer selection already started
  releaseMapState();
  current = map;
  if (!ensureViewer()) {
    status(statusFor(map));
    return;
  }
  const texelFor = resolveTexelFor(assetSlots.map((s) => s.pak));
  // Real palette when a PAK provides it (asset PAKs first, then the map's
  // own PAK); otherwise the renderer's procedural fallback stays installed.
  // The palette persists across maps like brightness — a display setting,
  // not map state.
  try {
    const cm = resolveColormapPcx(
      assetPaks(),
      mapPak?.pak ?? null,
    );
    if (cm) {
      renderer!.setColormap(cm.palette, cm.pixels);
      lastPalette = cm.palette;
    }
  } catch {
    /* palette install is best-effort */
  }
  const skyLine = installSky();
  try {
    renderer!.setMap(map.bsp, texelFor as never);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    return;
  }
  const enemyLine = installEnemies();
  resetCameraToSpawn();
  try {
    panelHandle?.setMap(map.bsp as never, map.name);
  } catch {
    /* panel map refresh is best-effort */
  }
  const st = renderer!.getStatus();
  status([
    ...statusFor(map),
    `surfaces: ${st.surfaces} · submodels: ${st.submodels} (static) · mode: ${st.mode}`,
    `palette: ${st.palette} · brightness: ${st.brightness.toFixed(1)} · ${skyLine}`,
    enemyLine,
  ]);
}

function showError(message: string): void {
  const prior = current ? statusFor(current) : ['no map loaded'];
  status([...prior, `error: ${message}`]);
}

function assetPaks(): WebPak[] {
  return assetSlots.map((s) => s.pak);
}

function refreshPrecedence(): void {
  const node = el('mv-assets');
  if (node) node.textContent = describePrecedence(assetSlots);
}

async function onStandaloneFile(file: File): Promise<void> {
  const gen = ++generation;
  try {
    await showLoaded(await loadStandaloneBsp(file, assetPaks()), gen);
  } catch (err) {
    if (gen !== generation) return;
    showError(err instanceof Error ? err.message : String(err));
  }
}

async function onMapPakFile(file: File): Promise<void> {
  const gen = ++generation;
  try {
    const pak = await parsePakFile(file);
    if (gen !== generation) return; // stale parse; drop it
    mapPak = { label: file.name, pak };
    const maps = listPakMaps(pak);
    const select = el<HTMLSelectElement>('mv-map-select');
    if (select) {
      select.innerHTML = '';
      for (const m of maps) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        select.appendChild(opt);
      }
    }
    status([`${file.name}: ${maps.length} map(s)`, ...maps]);
    if (maps.length > 0) {
      await showLoaded(loadPakMap(pak, maps[0]!), gen);
    }
  } catch (err) {
    if (gen !== generation) return;
    showError(err instanceof Error ? err.message : String(err));
  }
}

function onMapSelected(name: string): void {
  if (!mapPak) return;
  const gen = ++generation;
  try {
    void showLoaded(loadPakMap(mapPak.pak, name), gen);
  } catch (err) {
    if (gen !== generation) return;
    showError(err instanceof Error ? err.message : String(err));
  }
}

async function onAssetPakFiles(files: File[]): Promise<void> {
  const gen = ++generation;
  try {
    const slots: AssetPakSlot[] = [];
    for (const f of files) {
      slots.push({ label: f.name, pak: await parsePakFile(f) });
      if (gen !== generation) return; // stale: a newer pick started
    }
    assetSlots = slots;
    refreshPrecedence();
    // Re-resolve textures + palette/sky/enemies for the current map without losing camera pose.
    let enemyLine = 'enemies: 0';
    if (current && renderer) {
      const texelFor = resolveTexelFor(assetPaks());
      try {
        const cm = resolveColormapPcx(assetPaks(), mapPak?.pak ?? null);
        if (cm) {
          renderer.setColormap(cm.palette, cm.pixels);
          lastPalette = cm.palette;
        }
      } catch {
        /* keep previous palette on failure */
      }
      installSky();
      try {
        renderer.setMap(current.bsp, texelFor as never);
      } catch {
        /* keep old conversion on failure */
      }
      enemyLine = installEnemies();
    }
    status([
      `asset PAKs: ${slots.length}`,
      describePrecedence(assetSlots),
      ...(current ? [...statusFor(current), enemyLine] : ['no map loaded']),
    ]);
  } catch (err) {
    if (gen !== generation) return;
    showError(err instanceof Error ? err.message : String(err));
  }
}

async function onCapture(): Promise<void> {
  const canvas = el<HTMLCanvasElement>('mv');
  if (!canvas) return;
  const poseText = camera ? camera.toCopyable() : 'origin 0 0 0; angles 0 0 0';
  const mapName = current ? current.name : 'no-map';
  const result = await captureViewerCanvas(canvas as never, { mapName, poseText });
  status([
    ...(current ? statusFor(current) : ['no map loaded']),
    `capture: ${result.filename} download=${result.downloaded ? 'yes' : 'blocked'} clipboard=${result.copied ? 'yes' : 'manual-copy'}`,
    result.metadata,
  ]);
}

function onResetView(): void {
  resetCameraToSpawn();
  if (current && camera) status([...statusFor(current), `view: ${camera.toCopyable()}`]);
}

function filesOf(input: HTMLInputElement): File[] {
  return input.files ? Array.from(input.files) : [];
}

function ensureCaptureButton(): void {
  if (typeof document === 'undefined' || document.getElementById('mv-capture')) return;
  const bar = document.getElementById('mv-bar');
  if (!bar) return;
  const btn = document.createElement('button');
  btn.id = 'mv-capture';
  btn.type = 'button';
  btn.textContent = 'capture PNG';
  btn.addEventListener('click', () => void onCapture());
  bar.appendChild(btn);
  const reset = document.createElement('button');
  reset.id = 'mv-reset';
  reset.type = 'button';
  reset.textContent = 'reset view';
  reset.addEventListener('click', onResetView);
  bar.appendChild(reset);
  const brightLabel = document.createElement('label');
  brightLabel.htmlFor = 'mv-brightness';
  brightLabel.textContent = 'brightness';
  brightLabel.title = 'display-only lift, matches the game default of 2.0';
  const bright = document.createElement('input');
  bright.id = 'mv-brightness';
  bright.type = 'range';
  bright.min = '0.5';
  bright.max = '3.0';
  bright.step = '0.1';
  bright.value = '2.0';
  bright.addEventListener('input', () => {
    const v = Number(bright.value);
    try {
      renderer?.setBrightness(v);
    } catch {
      /* slider must never break the loop */
    }
  });
  brightLabel.appendChild(bright);
  bar.appendChild(brightLabel);
  const enemyLabel = document.createElement('label');
  enemyLabel.htmlFor = 'mv-enemies';
  enemyLabel.textContent = 'enemies';
  enemyLabel.title = 'render monster spawns as static MD2s at their spawn poses (no AI)';
  const enemyBox = document.createElement('input');
  enemyBox.id = 'mv-enemies';
  enemyBox.type = 'checkbox';
  enemyBox.checked = enemiesVisible;
  enemyBox.addEventListener('change', () => {
    enemiesVisible = enemyBox.checked;
    try {
      renderer?.setEnemiesVisible(enemiesVisible);
    } catch {
      /* toggle must never break the loop */
    }
  });
  enemyLabel.appendChild(enemyBox);
  bar.appendChild(enemyLabel);
  const hint = document.createElement('div');
  hint.id = 'mv-hint';
  hint.textContent = 'click the canvas to capture mouse look (Esc releases) · WASD move · Space/C vertical · Shift fast';
  bar.appendChild(hint);
}

function wire(): void {
  if (typeof document === 'undefined') return;
  ensureCaptureButton();
  ensureViewer();
  const bspInput = el<HTMLInputElement>('mv-bsp-file');
  bspInput?.addEventListener('change', () => {
    const files = bspInput ? filesOf(bspInput) : [];
    if (files[0]) void onStandaloneFile(files[0]);
    if (bspInput) bspInput.value = '';
  });
  const pakInput = el<HTMLInputElement>('mv-pak-file');
  pakInput?.addEventListener('change', () => {
    const files = pakInput ? filesOf(pakInput) : [];
    if (files[0]) void onMapPakFile(files[0]);
    if (pakInput) pakInput.value = '';
  });
  const assetInput = el<HTMLInputElement>('mv-asset-paks');
  assetInput?.addEventListener('change', () => {
    if (assetInput) void onAssetPakFiles(filesOf(assetInput));
    if (assetInput) assetInput.value = '';
  });
  el<HTMLSelectElement>('mv-map-select')?.addEventListener('change', (ev) => {
    const value = (ev.target as HTMLSelectElement).value;
    if (value) onMapSelected(value);
  });
  const drop = el('mv-drop') ?? document.body;
  drop.addEventListener('dragover', (ev) => ev.preventDefault());
  drop.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const files = ev.dataTransfer ? Array.from(ev.dataTransfer.files) : [];
    const bsp = files.find((f) => f.name.toLowerCase().endsWith('.bsp'));
    if (bsp) {
      void onStandaloneFile(bsp);
      return;
    }
    const pak = files.find((f) => f.name.toLowerCase().endsWith('.pak'));
    if (pak) void onMapPakFile(pak);
  });
  try {
    window.addEventListener('blur', () => {
      // Focus loss must not leave the loop rendering stale key state;
      // camera clears keys on blur/lock-loss internally.
    });
  } catch {
    /* ignore */
  }
  refreshPrecedence();
  if (!current) status(['no map loaded — pick a .bsp, drop one, or open a .pak']);
}

wire();

/** Test seam: reset module-level page state between isolated checks. */
export function __resetViewerForTest(): void {
  generation = 0;
  assetSlots = [];
  mapPak = null;
  lastPalette = null;
  enemiesVisible = true;
  stopLoop();
  try {
    detachCamera?.();
  } catch {
    /* ignore */
  }
  detachCamera = null;
  try {
    panelHandle?.dispose();
  } catch {
    /* ignore */
  }
  panelHandle = null;
  try {
    renderer?.dispose();
  } catch {
    /* ignore */
  }
  renderer = null;
  camera = null;
  releaseMapState();
}
