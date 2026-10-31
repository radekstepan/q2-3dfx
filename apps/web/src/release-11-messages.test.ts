// RELEASE-11 apps/web lane: `cl_showmessages` gates ONLY the transient
// cosmetic status line (tagged 'status'); death ('alert'), the finished
// screen, and loading/fallback warnings always draw.
//
// Every producer below is exercised through the real path — `bootPlay` +
// driver ticks — never hand-built message strings: if a producer stops
// tagging its write, the kind assertions fail (missing-effect style).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UserCmdT } from '@q2/input';
import { getCVarNumber, getCVarString, resetCVars, setCVar } from '@q2/config';
import { v3 } from '@q2/math';
import { monsterPain, spawnEdict } from '@q2/game';
import { SV_SpawnMonster } from '@q2/server';
import type { ServerMonster } from '@q2/server';
import {
  bootPlay,
  drawPlayHud,
  FINISH_BLUE,
  FPS_GREEN,
  messagesVisible,
  paintHudOverlay,
  POS_GREY,
  toggleHelpOverlay,
} from './play.js';
import type { LocalDriver, PlayBoot } from './play.js';
import {
  CHECKBOX_CVARS,
  cvarControlKind,
  cvarDescription,
  cvarGroup,
  cvarIsCheckbox,
  cvarNeedsReboot,
  renderCvarPanel,
  restorePersistedCVars,
  savePersistedCVars,
  showMessagesEnabled,
} from './dom.js';

/** In-canvas transient status line colour (drawPlayHud, post-resolve). */
const STATUS_YELLOW = 0xffffff00;

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

function attackCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 1 };
}

function stepDriver(driver: LocalDriver, cmd: UserCmdT, n: number): void {
  for (let i = 0; i < n; i++) driver.step(cmd, 0.1);
}

/** Step until a weapon switch completes (cap guards against a stuck switch). */
function waitReady(driver: LocalDriver, cap = 40): void {
  let n = 0;
  while (driver.weaponSwitching && n++ < cap) stepDriver(driver, neutralCmd(), 1);
  expect(driver.weaponSwitching).toBe(false);
}

function freshTarget(width: number, height: number): { width: number; height: number; color: Uint32Array } {
  return { width, height, color: new Uint32Array(width * height) };
}

/** Draw the HUD onto a fresh (world-free) buffer and return it. */
function drawHud(boot: PlayBoot, width: number, height: number, fps = 0): Uint32Array {
  const target = freshTarget(width, height);
  drawPlayHud(target, boot, { fps, frame: 1 });
  return target.color;
}

function countColor(color: Uint32Array, rgba: number): number {
  let n = 0;
  for (let i = 0; i < color.length; i++) {
    if (color[i] === rgba) n++;
  }
  return n;
}

/** Kill one soldier through the real tick path (monsterPain + step). */
function killSoldier(driver: LocalDriver): ServerMonster {
  const m = SV_SpawnMonster(driver.server, 'monster_soldier', v3(100, 0, 32));
  expect(monsterPain(m.state, 30, () => 0.5)).toBe('dead');
  stepDriver(driver, neutralCmd(), 1);
  expect(driver.events).toContain('kill');
  return m;
}

/** Mince one soldier through the real tick path (overkill gib + step). */
function gibSoldier(driver: LocalDriver): ServerMonster {
  const m = SV_SpawnMonster(driver.server, 'monster_soldier', v3(100, 0, 32));
  expect(monsterPain(m.state, 200, () => 0.5)).toBe('gib');
  stepDriver(driver, neutralCmd(), 1);
  expect(driver.events).toContain('gib');
  return m;
}

beforeEach(() => {
  resetCVars();
});

afterEach(() => {
  resetCVars();
  const g = globalThis as unknown as { document?: unknown };
  if (g.document instanceof FakeDocument) g.document = undefined;
  uninstallLocalStorage();
});

// --- fake DOM (same pattern as pos.test.ts) --------------------------------

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
  title = '';
  tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  appendChild(child: FakeElement): void {
    this.children.push(child);
  }
  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  set innerHTML(_v: string) {
    this.children = [];
  }
  dispatch(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({});
  }
}

class FakeContainer extends FakeElement {
  constructor() {
    super('div');
  }
}

class FakeDocument {
  docListeners = new Map<string, Listener[]>();
  created: FakeElement[] = [];
  createElement(tag: string): FakeElement {
    const el = new FakeElement(tag);
    this.created.push(el);
    return el;
  }
  addEventListener(type: string, fn: Listener): void {
    const list = this.docListeners.get(type) ?? [];
    list.push(fn);
    this.docListeners.set(type, list);
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

function findRow(container: FakeContainer, name: string): FakeElement {
  const row = container.children.find((r) => r.children[0]?.textContent === name);
  expect(row, `row for ${name}`).toBeDefined();
  return row!;
}

// --- localStorage stub (Node has none; dom.ts guards on typeof) ------------

interface FakeStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

let storagePrev: unknown = undefined;
let storageInstalled = false;
const storageMap = new Map<string, string>();

function installLocalStorage(): FakeStorage {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!storageInstalled) {
    storagePrev = g['localStorage'];
    storageInstalled = true;
  }
  storageMap.clear();
  const stub: FakeStorage = {
    getItem: (k: string): string | null => (storageMap.has(k) ? storageMap.get(k)! : null),
    setItem: (k: string, v: string): void => {
      storageMap.set(k, String(v));
    },
    removeItem: (k: string): void => {
      storageMap.delete(k);
    },
  };
  g['localStorage'] = stub;
  return stub;
}

function uninstallLocalStorage(): void {
  if (!storageInstalled) return;
  const g = globalThis as unknown as Record<string, unknown>;
  if (storagePrev === undefined) delete g['localStorage'];
  else g['localStorage'] = storagePrev;
  storageInstalled = false;
  storageMap.clear();
}

describe('RELEASE-11 message producer tagging (real bootPlay + ticks)', () => {
  it("kill gib lines are cosmetic 'status'", () => {
    const boot = bootPlay({ width: 320, height: 240 });
    const { driver } = boot;
    const m = killSoldier(driver);
    expect(m.state.dead).toBe(true);
    expect(driver.message).toBe('soldier down');
    expect(driver.messageKind).toBe('status');
  });

  it("monster overkill mince is cosmetic 'status'", () => {
    const boot = bootPlay({ width: 320, height: 240 });
    const { driver } = boot;
    const m = gibSoldier(driver);
    expect(m.state.gibbed).toBe(true);
    expect(driver.message).toBe('soldier minced');
    expect(driver.messageKind).toBe('status');
  });

  it("corpse overkill mince is cosmetic 'status'", () => {
    const boot = bootPlay({ width: 320, height: 240 });
    const { driver } = boot;
    // A re-gibbed misc_deadsoldier surfaces through the real server drain.
    const corpse = spawnEdict({ classname: 'misc_deadsoldier' });
    corpse.extra['gibHits'] = '1';
    driver.server.entities.push(corpse);
    stepDriver(driver, neutralCmd(), 1);
    expect(driver.events).toContain('gib');
    expect(driver.message).toBe('corpse minced');
    expect(driver.messageKind).toBe('status');
  });

  it("walk-over pickup names the item as cosmetic 'status'", () => {
    const boot = bootPlay({ width: 320, height: 240 });
    const { driver } = boot;
    // Health below max so item_health grants through the real pickup path.
    driver.damagePlayer(30);
    expect(driver.playerHealth).toBe(70);
    const p = driver.pm.origin;
    const item = spawnEdict({
      classname: 'item_health',
      origin: `${p[0]!} ${p[1]!} ${p[2]!}`,
    });
    driver.server.entities.push(item);
    stepDriver(driver, neutralCmd(), 1);
    expect(driver.events).toContain('pickup');
    expect(driver.message).toBe('item health');
    expect(driver.messageKind).toBe('status');
  });

  it("weapon switch + NO WEAPON are cosmetic 'status'", () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    driver.ps.weapons.push('weapon_shotgun');
    driver.selectWeapon('weapon_shotgun');
    expect(driver.events).toContain('weapon');
    expect(driver.message).toBe('weapon shotgun');
    expect(driver.messageKind).toBe('status');
    driver.selectWeapon('weapon_railgun');
    expect(driver.events).toContain('empty');
    expect(driver.message).toBe('NO WEAPON');
    expect(driver.messageKind).toBe('status');
  });

  it("dry-fire NO AMMO and the fire clear are cosmetic 'status'", () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    driver.ps.weapons.push('weapon_shotgun');
    driver.selectWeapon('weapon_shotgun');
    waitReady(driver);
    driver.shells = 0;
    driver.step(attackCmd(), 0.1);
    expect(driver.events).toContain('empty');
    expect(driver.message).toBe('NO AMMO');
    expect(driver.messageKind).toBe('status');
    // A live round clears the line (still a cosmetic write): settle past
    // the shotgun refire window first, or the trigger stays latched.
    driver.shells = 8;
    stepDriver(driver, neutralCmd(), 12);
    driver.step(attackCmd(), 0.1);
    expect(driver.events).toContain('shot');
    expect(driver.message).toBe('');
    expect(driver.messageKind).toBe('status');
  });

  it("death is essential 'alert' and respawn resets the kind", () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    driver.damagePlayer(200);
    expect(driver.events).toContain('death');
    expect(driver.message).toBe('YOU DIED — respawning…');
    expect(driver.messageKind).toBe('alert');
    // The respawn clear resets the kind so no stale 'alert' leaks onward.
    stepDriver(driver, neutralCmd(), 25);
    expect(driver.events).toContain('respawn');
    expect(driver.playerDead).toBe(false);
    expect(driver.message).toBe('');
    expect(driver.messageKind).toBe('status');
  });

  it('finished-screen mirror keeps the kind (gate keys off server.finished)', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    driver.server.finished = true;
    stepDriver(driver, neutralCmd(), 1);
    expect(driver.message).toContain('LEVEL COMPLETE');
    expect(driver.messageKind).toBe('status');
  });
});

describe('RELEASE-11 cl_showmessages render gate (draw-only)', () => {
  it('toggling during an active message hides/shows it immediately (no reboot)', () => {
    const boot = bootPlay({ width: 320, height: 240 });
    const { driver } = boot;
    killSoldier(driver);
    expect(driver.message).toBe('soldier down');
    // Shown by default.
    expect(countColor(drawHud(boot, 320, 240), STATUS_YELLOW)).toBeGreaterThan(0);
    // Hiding needs no reboot: the very next present drops the line, and the
    // string itself is untouched (gating is draw-only).
    setCVar('cl_showmessages', 0);
    expect(driver.message).toBe('soldier down');
    expect(countColor(drawHud(boot, 320, 240), STATUS_YELLOW)).toBe(0);
    // Re-enabling restores the SAME active message with no new event.
    const events = driver.events.length;
    setCVar('cl_showmessages', 1);
    expect(driver.events.length).toBe(events);
    expect(countColor(drawHud(boot, 320, 240), STATUS_YELLOW)).toBeGreaterThan(0);
  });

  it('subsequent events update state/stats while hidden and show on re-enable', () => {
    const boot = bootPlay({ width: 320, height: 240 });
    const { driver } = boot;
    killSoldier(driver);
    const kills = driver.events.filter((e) => e === 'kill').length;
    setCVar('cl_showmessages', 0);
    expect(countColor(drawHud(boot, 320, 240), STATUS_YELLOW)).toBe(0);
    // A second kill while hidden: the string + events + monster state still
    // update (hiding never alters gameplay), but nothing draws.
    const m2 = gibSoldier(driver);
    expect(m2.state.gibbed).toBe(true);
    expect(driver.message).toBe('soldier minced');
    expect(driver.events.filter((e) => e === 'kill').length).toBe(kills);
    expect(driver.events).toContain('gib');
    expect(countColor(drawHud(boot, 320, 240), STATUS_YELLOW)).toBe(0);
    // A dry-fire while hidden: same deal — 'NO AMMO' + 'empty' recorded.
    driver.ps.weapons.push('weapon_shotgun');
    driver.selectWeapon('weapon_shotgun');
    waitReady(driver);
    driver.shells = 0;
    driver.step(attackCmd(), 0.1);
    expect(driver.message).toBe('NO AMMO');
    expect(driver.events).toContain('empty');
    expect(countColor(drawHud(boot, 320, 240), STATUS_YELLOW)).toBe(0);
    // Re-enable: the latest line shows at once.
    setCVar('cl_showmessages', 1);
    expect(countColor(drawHud(boot, 320, 240), STATUS_YELLOW)).toBeGreaterThan(0);
  });

  it('death still shows while cosmetic text hides', () => {
    const boot = bootPlay({ width: 320, height: 240 });
    const { driver } = boot;
    setCVar('cl_showmessages', 0);
    driver.damagePlayer(200);
    expect(driver.messageKind).toBe('alert');
    expect(countColor(drawHud(boot, 320, 240), STATUS_YELLOW)).toBeGreaterThan(0);
    // The death lifecycle is unaffected: respawn still clears the line.
    stepDriver(driver, neutralCmd(), 25);
    expect(driver.events).toContain('respawn');
    expect(driver.message).toBe('');
  });

  it('finish screen still shows while cosmetic text hides', () => {
    const boot = bootPlay({ width: 320, height: 240 });
    const { driver } = boot;
    setCVar('cl_showmessages', 0);
    driver.server.finished = true;
    stepDriver(driver, neutralCmd(), 1);
    // The essential mirror still ran (events/stats update while hidden).
    expect(driver.message).toContain('LEVEL COMPLETE');
    expect(driver.events).toContain('finished');
    const color = drawHud(boot, 320, 240);
    expect(countColor(color, FINISH_BLUE)).toBeGreaterThan(0);
  });

  it('FPS/pos/HUD/help are unaffected, and a quiet HUD is pixel-identical', () => {
    const boot = bootPlay({ width: 320, height: 240 });
    expect(boot.driver.message).toBe('');
    setCVar('cl_showmessages', 0);
    const color = drawHud(boot, 320, 240, 60);
    // FPS + position + statusbar rows still draw while messages hide.
    expect(countColor(color, FPS_GREEN)).toBeGreaterThan(0);
    expect(countColor(color, POS_GREY)).toBeGreaterThan(0);
    expect(countColor(color, 0xffffffff)).toBeGreaterThan(0);
    // F1 help overlay still draws while messages hide.
    expect(toggleHelpOverlay(boot)).toBe(true);
    const help = drawHud(boot, 320, 240, 60);
    expect(countColor(help, 0xcc101010)).toBeGreaterThan(0);
    expect(toggleHelpOverlay(boot)).toBe(false);
    // With no active message the cvar changes zero pixels.
    const shown = drawHud(boot, 320, 240, 60);
    setCVar('cl_showmessages', 1);
    const hidden = drawHud(boot, 320, 240, 60);
    expect([...hidden]).toEqual([...shown]);
  });
});

describe('RELEASE-11 both renderers × resolutions', () => {
  for (const [w, h] of [[320, 240], [1024, 768]] as const) {
    it(`software resolve + webgl2 overlay paths gate at ${w}x${h}`, () => {
      const boot = bootPlay({ width: w, height: h });
      const { driver } = boot;
      killSoldier(driver);
      expect(driver.message).toBe('soldier down');
      // Software path (production order: resolve, then post-resolve HUD).
      // Fresh-target pins pin the gate exactly; the overlay leg below
      // covers the other production path.
      expect(countColor(drawHud(boot, w, h), STATUS_YELLOW)).toBeGreaterThan(0);
      setCVar('cl_showmessages', 0);
      expect(countColor(drawHud(boot, w, h), STATUS_YELLOW)).toBe(0);
      setCVar('cl_showmessages', 1);
      // WebGL2 path: the transparent overlay paints the SAME drawPlayHud
      // pass post-resolve (paintHudOverlay zeroes the display plane first).
      const shown = paintHudOverlay(boot, { fps: 0, frame: 1 });
      expect(countColor(shown, STATUS_YELLOW)).toBeGreaterThan(0);
      setCVar('cl_showmessages', 0);
      const hidden = paintHudOverlay(boot, { fps: 0, frame: 1 });
      expect(countColor(hidden, STATUS_YELLOW)).toBe(0);
      // Death still punches through the overlay while hidden.
      driver.damagePlayer(200);
      const death = paintHudOverlay(boot, { fps: 0, frame: 1 });
      expect(countColor(death, STATUS_YELLOW)).toBeGreaterThan(0);
    });
  }
});

describe('RELEASE-11 panel + persistence', () => {
  it('gate defaults ON and both helpers agree', () => {
    expect(showMessagesEnabled()).toBe(true);
    expect(messagesVisible()).toBe(true);
    setCVar('cl_showmessages', 0);
    expect(showMessagesEnabled()).toBe(false);
    expect(messagesVisible()).toBe(false);
    setCVar('cl_showmessages', 1);
    expect(showMessagesEnabled()).toBe(true);
    expect(messagesVisible()).toBe(true);
  });

  it('cl_showmessages is a HUD checkbox with a description, never a reboot cvar', () => {
    expect(CHECKBOX_CVARS.has('cl_showmessages')).toBe(true);
    expect(cvarIsCheckbox('cl_showmessages')).toBe(true);
    expect(cvarControlKind('cl_showmessages')).toBe('checkbox');
    expect(cvarGroup('cl_showmessages')).toBe('HUD');
    expect(cvarDescription('cl_showmessages')).toContain('status');
    // Applies immediately: not a reboot cvar.
    expect(cvarNeedsReboot('cl_showmessages')).toBe(false);
  });

  it('panel lists the row and the checkbox toggles the cvar', () => {
    const { prev } = install();
    try {
      const container = new FakeContainer();
      const seen: Array<[string, string]> = [];
      const names = renderCvarPanel(container, '', (n, v) => seen.push([n, v]));
      expect(names).toContain('cl_showmessages');
      const row = findRow(container, 'cl_showmessages');
      const box = row.children[1]!;
      expect(box.type).toBe('checkbox');
      expect(box.checked).toBe(true); // default ON
      box.checked = false;
      box.dispatch('change');
      expect(getCVarNumber('cl_showmessages')).toBe(0);
      expect(seen).toContainEqual(['cl_showmessages', '0']);
      expect(showMessagesEnabled()).toBe(false);
      box.checked = true;
      box.dispatch('change');
      expect(getCVarNumber('cl_showmessages')).toBe(1);
      expect(seen).toContainEqual(['cl_showmessages', '1']);
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });

  it('reload persistence round-trips the toggle', () => {
    const store = installLocalStorage();
    try {
      // Hide -> save -> fresh defaults -> restore: still hidden.
      setCVar('cl_showmessages', 0);
      savePersistedCVars();
      const raw = store.getItem('q2ts.cvars.v1');
      expect(raw).toContain('cl_showmessages');
      resetCVars();
      // Fresh defaults mean ON: either the central default (1, once the
      // config package rebuilds) or absent-means-on (stale dist — the
      // ensureHudCvars pattern exists for exactly this).
      expect(showMessagesEnabled()).toBe(true);
      expect(messagesVisible()).toBe(true);
      restorePersistedCVars();
      expect(getCVarNumber('cl_showmessages')).toBe(0);
      expect(getCVarString('cl_showmessages')).toBe('0');
      // Show -> save -> fresh defaults -> restore: still shown.
      setCVar('cl_showmessages', 1);
      savePersistedCVars();
      setCVar('cl_showmessages', 0);
      restorePersistedCVars();
      expect(getCVarNumber('cl_showmessages')).toBe(1);
    } finally {
      uninstallLocalStorage();
    }
  });

  it('panel reflects the restored value after a reload', () => {
    installLocalStorage();
    const { prev } = install();
    try {
      setCVar('cl_showmessages', 0);
      savePersistedCVars();
      resetCVars();
      restorePersistedCVars();
      const container = new FakeContainer();
      renderCvarPanel(container, '', () => undefined);
      const box = findRow(container, 'cl_showmessages').children[1]!;
      expect(box.checked).toBe(false);
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
      uninstallLocalStorage();
    }
  });
});
