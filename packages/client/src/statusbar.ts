// @q2/client/statusbar — statusbar layout string parsing (M6.1).
//
// The server ships the HUD layout in configstring CS_STATUSBAR: a small
// script (`xv 32 yv 144 pic 0 client 0 num 3 10 ...`) executed each frame.
// This module tokenizes + parses it into ops; the web HUD executes the ops.

import { Com_Error } from '@q2/config';

/** Q2 configstring index carrying the statusbar layout. */
export const CS_STATUSBAR = 5;

/**
 * Playerstat indices (`game/q_shared.h`). The single-player statusbar script
 * (`game/g_spawn.c: single_statusbar`) reads 0-13; 14-17 are deathmatch-only.
 */
export const STAT_HEALTH_ICON = 0;
export const STAT_HEALTH = 1;
export const STAT_AMMO_ICON = 2;
export const STAT_AMMO = 3;
export const STAT_ARMOR_ICON = 4;
export const STAT_ARMOR = 5;
export const STAT_SELECTED_ICON = 6;
export const STAT_PICKUP_ICON = 7;
export const STAT_PICKUP_STRING = 8;
export const STAT_TIMER_ICON = 9;
export const STAT_TIMER = 10;
export const STAT_HELPICON = 11;
export const STAT_SELECTED_ITEM = 12;
export const STAT_LAYOUTS = 13;
export const STAT_FRAGS = 14;
/** Cleared each frame: bit 0 = health flash, bit 1 = armor flash, bit 2 = ammo flash. */
export const STAT_FLASHES = 15;
export const STAT_CHASE = 16;
export const STAT_SPECTATOR = 17;

/** Flash bits inside `STAT_FLASHES` (`game/p_view.c`). */
export const FLASH_HEALTH = 1;
export const FLASH_ARMOR = 2;
export const FLASH_AMMO = 4;

/** Absolute limit for `pic` stat values and `client` slots (`q_shared.h`). */
export const MAX_IMAGES = 256;
export const MAX_CLIENTS = 256;

/** Digit pic sets: `num_*` normal, `anum_*` alert (`client/cl_scrn.c: sb_nums`). */
export type DigitStyle = 'num' | 'anum';

/** Layout-script cursor modes (`client/cl_scrn.c: SCR_ExecuteLayoutString`). */
export type LayoutXMode = 'xl' | 'xr' | 'xv';
export type LayoutYMode = 'yt' | 'yb' | 'yv';

export type StatusOp =
  | { op: 'pos'; x: number; y: number; xMode: LayoutXMode; yMode: LayoutYMode }
  | { op: 'pic'; index: number }
  | { op: 'picn'; name: string }
  | { op: 'client'; x: number; y: number; slot: number; score: number; ping: number; time: number }
  | { op: 'ctf'; x: number; y: number; slot: number; score: number; ping: number }
  | { op: 'num'; width: number; index: number }
  | { op: 'hnum' }
  | { op: 'anum' }
  | { op: 'rnum' }
  | { op: 'stat_string'; index: number }
  | { op: 'cstring'; text: string }
  | { op: 'string'; text: string }
  | { op: 'cstring2'; text: string }
  | { op: 'string2'; text: string }
  | { op: 'if'; index: number }
  | { op: 'ifnot'; index: number }
  | { op: 'ifeq'; index: number; value: number }
  | { op: 'ifbit'; index: number; bit: number }
  | { op: 'endif' }
  | { op: 'unknown'; token: string };

/** Split a layout script into tokens, honouring "quoted strings". */
export function tokenizeLayout(layout: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < layout.length; i++) {
    const c = layout[i]!;
    if (inQuote) {
      if (c === '"') {
        tokens.push(cur);
        cur = '';
        inQuote = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuote = true;
    } else if (/\s/.test(c)) {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = '';
      }
    } else {
      cur += c;
    }
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

const num = (t: string | undefined, what: string): number => {
  const n = Number(t);
  if (t === undefined || !Number.isFinite(n)) throw new Error(`statusbar: expected number after ${what}`);
  return n | 0;
};

/** Parse a full statusbar layout script into ops. */
export function parseStatusbar(layout: string): StatusOp[] {
  const toks = tokenizeLayout(layout);
  const ops: StatusOp[] = [];
  let x = 0;
  let y = 0;
  let xMode: LayoutXMode = 'xl';
  let yMode: LayoutYMode = 'yt';
  let dirty = false;
  const flush = (): void => {
    if (dirty) {
      ops.push({ op: 'pos', x, y, xMode, yMode });
      dirty = false;
    }
  };
  let i = 0;
  while (i < toks.length) {
    const t = toks[i++]!;
    switch (t) {
      case 'xl': x = num(toks[i++], 'xl'); xMode = 'xl'; dirty = true; break;
      case 'xr': x = num(toks[i++], 'xr'); xMode = 'xr'; dirty = true; break;
      case 'xv': x = num(toks[i++], 'xv'); xMode = 'xv'; dirty = true; break;
      case 'yb': y = num(toks[i++], 'yb'); yMode = 'yb'; dirty = true; break;
      case 'yt': y = num(toks[i++], 'yt'); yMode = 'yt'; dirty = true; break;
      case 'yv': y = num(toks[i++], 'yv'); yMode = 'yv'; dirty = true; break;
      case 'pic': flush(); ops.push({ op: 'pic', index: num(toks[i++], 'pic') }); break;
      case 'picn': flush(); ops.push({ op: 'picn', name: toks[i++] ?? '' }); break;
      case 'client': flush(); {
        // `client` carries its own xv/yv cursor (scoreboard blocks).
        const cx = num(toks[i++], 'client x');
        const cy = num(toks[i++], 'client y');
        const slot = num(toks[i++], 'client slot');
        const score = num(toks[i++], 'client score');
        const ping = num(toks[i++], 'client ping');
        const time = num(toks[i++], 'client time');
        ops.push({ op: 'client', x: cx, y: cy, slot, score, ping, time });
        break;
      }
      case 'ctf': flush(); {
        const cx = num(toks[i++], 'ctf x');
        const cy = num(toks[i++], 'ctf y');
        const slot = num(toks[i++], 'ctf slot');
        const score = num(toks[i++], 'ctf score');
        const ping = num(toks[i++], 'ctf ping');
        ops.push({ op: 'ctf', x: cx, y: cy, slot, score, ping });
        break;
      }
      case 'num': flush(); {
        const width = num(toks[i++], 'num width');
        const index = num(toks[i++], 'num index');
        ops.push({ op: 'num', width, index });
        break;
      }
      case 'hnum': flush(); ops.push({ op: 'hnum' }); break;
      case 'anum': flush(); ops.push({ op: 'anum' }); break;
      case 'rnum': flush(); ops.push({ op: 'rnum' }); break;
      case 'stat_string': flush(); ops.push({ op: 'stat_string', index: num(toks[i++], 'stat_string') }); break;
      case 'cstring': flush(); ops.push({ op: 'cstring', text: toks[i++] ?? '' }); break;
      case 'string': flush(); ops.push({ op: 'string', text: toks[i++] ?? '' }); break;
      case 'cstring2': flush(); ops.push({ op: 'cstring2', text: toks[i++] ?? '' }); break;
      case 'string2': flush(); ops.push({ op: 'string2', text: toks[i++] ?? '' }); break;
      case 'if': flush(); ops.push({ op: 'if', index: num(toks[i++], 'if') }); break;
      case 'ifnot': flush(); ops.push({ op: 'ifnot', index: num(toks[i++], 'ifnot') }); break;
      case 'ifeq': flush(); {
        const index = num(toks[i++], 'ifeq index');
        const value = num(toks[i++], 'ifeq value');
        ops.push({ op: 'ifeq', index, value });
        break;
      }
      case 'ifbit': flush(); {
        const index = num(toks[i++], 'ifbit index');
        const bit = num(toks[i++], 'ifbit bit');
        ops.push({ op: 'ifbit', index, bit });
        break;
      }
      case 'endif': flush(); ops.push({ op: 'endif' }); break;
      default: ops.push({ op: 'unknown', token: t }); break;
    }
  }
  flush();
  return ops;
}

/** Minimal configstring store (index -> string). */
export class Configstrings {
  private map = new Map<number, string>();

  set(index: number, value: string): void {
    this.map.set(index, value);
  }

  get(index: number): string {
    return this.map.get(index) ?? '';
  }

  /** Parse the statusbar layout from CS_STATUSBAR ('' if unset). */
  statusbar(): StatusOp[] {
    const layout = this.get(CS_STATUSBAR);
    if (!layout) return [];
    return parseStatusbar(layout);
  }
}

// ---------------------------------------------------------------------------
// Layout execution (RELEASE-6): `SCR_ExecuteLayoutString` semantics as pure
// data. The integrator maps `StatusDrawCmd` to `drawPic`/`drawField`/
// `drawString` calls; this module owns the original coordinate mapping,
// conditionals and health/ammo/armor flash rules.
// ---------------------------------------------------------------------------

/**
 * Resolve a layout-script x cursor to framebuffer pixels. `xv` is relative to
 * the 320-wide virtual origin (`width/2-160`), `xr` to the right edge, `xl`
 * absolute — all truncated like id's integer math.
 */
export function layoutX(mode: LayoutXMode, v: number, screenW: number): number {
  switch (mode) {
    case 'xl': return v;
    case 'xr': return screenW + v;
    case 'xv': return Math.trunc(screenW / 2) - 160 + v;
  }
}

/** Resolve a layout-script y cursor (`yv` relative to `height/2-120`). */
export function layoutY(mode: LayoutYMode, v: number, screenH: number): number {
  switch (mode) {
    case 'yt': return v;
    case 'yb': return screenH + v;
    case 'yv': return Math.trunc(screenH / 2) - 120 + v;
  }
}

/** Scoreboard client facts; the integrator resolves names/icons. */
export interface StatusClientInfo {
  readonly name: string;
  readonly icon: string;
}

/** Frame state the layout program reads. */
export interface StatusbarState {
  /** Playerstats indexed by `STAT_*` (missing entries read as 0). */
  readonly stats: ReadonlyArray<number>;
  /** `CS_IMAGES` names by image index (''/missing = not precached, skipped). */
  readonly images: ReadonlyArray<string>;
  readonly configstrings: ReadonlyArray<string>;
  /** `cl.frame.serverframe` (drives the low-health/ammo blink). */
  readonly serverframe: number;
  /** Deathmatch client facts for `client`/`ctf` blocks (null = skip row). */
  readonly clientInfo: (slot: number) => StatusClientInfo | null;
}

export type StatusDrawCmd =
  /** Blit a named 24x24 (or tag/background) pic at the cursor. */
  | { readonly kind: 'pic'; readonly x: number; readonly y: number; readonly name: string }
  /** `SCR_DrawField`: digit pics, `num_*` normal vs `anum_*` alert. */
  | { readonly kind: 'field'; readonly x: number; readonly y: number; readonly style: DigitStyle; readonly width: number; readonly value: number }
  /** `DrawString`/`DrawHUDString`; `alt` = `string2` green, `centerWidth` = `cstring` centering. */
  | { readonly kind: 'text'; readonly x: number; readonly y: number; readonly text: string; readonly alt: boolean; readonly centerWidth: number }
  /** Scoreboard row: integrator resolves name/icon and draws the icon + stats. */
  | { readonly kind: 'client'; readonly x: number; readonly y: number; readonly slot: number; readonly score: number; readonly ping: number; readonly time: number }
  | { readonly kind: 'ctf'; readonly x: number; readonly y: number; readonly slot: number; readonly score: number; readonly ping: number };

/** `field_3` flash-field pic drawn behind flashing health/ammo/armor numbers. */
export const FLASH_FIELD_PIC = 'field_3';

const stat = (state: StatusbarState, index: number): number => state.stats[index] ?? 0;

/**
 * Execute a parsed statusbar program at a concrete framebuffer size.
 * Mirrors `SCR_ExecuteLayoutString`, including the `if`/`endif` skip, the
 * `field_3` flash backgrounds (`STAT_FLASHES` bits 1/2/4) and the low-value
 * blink (`(serverframe>>2)&1`). The `ifnot`/`ifeq`/`ifbit` forms are a
 * strict superset of id's `if`-only interpreter (documented in
 * `game/g_spawn.c`'s layout-spec comment); the shipped single-player and
 * deathmatch scripts only use `if`, so real assets render identically.
 */
export function executeStatusbar(
  ops: readonly StatusOp[],
  state: StatusbarState,
  screenW: number,
  screenH: number,
): StatusDrawCmd[] {
  const cmds: StatusDrawCmd[] = [];
  let x = 0;
  let y = 0;
  // `false` entries mean "skipping" (nested-safe; id stops at the first endif).
  const skipping: boolean[] = [];
  const skipped = (): boolean => skipping.some((s) => s === false);

  const field = (fx: number, fy: number, width: number, value: number, style: DigitStyle): void => {
    const w = Math.min(5, width);
    if (w < 1) return;
    cmds.push({ kind: 'field', x: fx, y: fy, style, width: w, value });
  };

  for (const op of ops) {
    switch (op.op) {
      case 'pos':
        x = layoutX(op.xMode, op.x, screenW);
        y = layoutY(op.yMode, op.y, screenH);
        break;
      case 'if':
        skipping.push(!skipped() && stat(state, op.index) !== 0);
        break;
      case 'ifnot':
        skipping.push(!skipped() && stat(state, op.index) === 0);
        break;
      case 'ifeq':
        skipping.push(!skipped() && stat(state, op.index) === op.value);
        break;
      case 'ifbit':
        skipping.push(!skipped() && (stat(state, op.index) & op.bit) !== 0);
        break;
      case 'endif':
        skipping.pop();
        break;
      case 'unknown':
        break;
      default: {
        if (skipped()) break;
        switch (op.op) {
          case 'pic': {
            // `pic N` draws the CS_IMAGES pic whose index sits in stat N.
            const value = stat(state, op.index);
            if (value >= MAX_IMAGES) Com_Error('fatal', `statusbar: pic value ${value} >= MAX_IMAGES`);
            const name = value >= 0 ? (state.images[value] ?? '') : '';
            if (name) cmds.push({ kind: 'pic', x, y, name });
            break;
          }
          case 'picn':
            if (op.name) cmds.push({ kind: 'pic', x, y, name: op.name });
            break;
          case 'client': {
            if (op.slot < 0 || op.slot >= MAX_CLIENTS) {
              Com_Error('fatal', `statusbar: client slot ${op.slot} out of range`);
            }
            if (state.clientInfo(op.slot) === null) break;
            cmds.push({
              kind: 'client',
              x: layoutX('xv', op.x, screenW),
              y: layoutY('yv', op.y, screenH),
              slot: op.slot, score: op.score, ping: op.ping, time: op.time,
            });
            break;
          }
          case 'ctf': {
            if (op.slot < 0 || op.slot >= MAX_CLIENTS) {
              Com_Error('fatal', `statusbar: ctf slot ${op.slot} out of range`);
            }
            if (state.clientInfo(op.slot) === null) break;
            cmds.push({
              kind: 'ctf',
              x: layoutX('xv', op.x, screenW),
              y: layoutY('yv', op.y, screenH),
              slot: op.slot, score: op.score, ping: Math.min(999, op.ping),
            });
            break;
          }
          case 'num':
            field(x, y, op.width, stat(state, op.index), 'num');
            break;
          case 'hnum': {
            const value = stat(state, STAT_HEALTH);
            const blink = ((state.serverframe >> 2) & 1) === 1;
            if ((stat(state, STAT_FLASHES) & FLASH_HEALTH) !== 0) {
              cmds.push({ kind: 'pic', x, y, name: FLASH_FIELD_PIC });
            }
            field(x, y, 3, value, value > 25 || !blink ? 'num' : 'anum');
            break;
          }
          case 'anum': {
            const value = stat(state, STAT_AMMO);
            if (value < 0) break;
            const blink = ((state.serverframe >> 2) & 1) === 1;
            if ((stat(state, STAT_FLASHES) & FLASH_AMMO) !== 0) {
              cmds.push({ kind: 'pic', x, y, name: FLASH_FIELD_PIC });
            }
            field(x, y, 3, value, value > 5 || !blink ? 'num' : 'anum');
            break;
          }
          case 'rnum': {
            const value = stat(state, STAT_ARMOR);
            if (value < 1) break;
            if ((stat(state, STAT_FLASHES) & FLASH_ARMOR) !== 0) {
              cmds.push({ kind: 'pic', x, y, name: FLASH_FIELD_PIC });
            }
            field(x, y, 3, value, 'num');
            break;
          }
          case 'stat_string': {
            const index = stat(state, op.index);
            if (index < 0 || index >= state.configstrings.length) {
              Com_Error('fatal', `statusbar: bad stat_string index ${index}`);
            }
            const text = state.configstrings[index] ?? '';
            if (text) cmds.push({ kind: 'text', x, y, text, alt: false, centerWidth: 0 });
            break;
          }
          case 'cstring':
            if (op.text) cmds.push({ kind: 'text', x, y, text: op.text, alt: false, centerWidth: 320 });
            break;
          case 'string':
            if (op.text) cmds.push({ kind: 'text', x, y, text: op.text, alt: false, centerWidth: 0 });
            break;
          case 'cstring2':
            if (op.text) cmds.push({ kind: 'text', x, y, text: op.text, alt: true, centerWidth: 320 });
            break;
          case 'string2':
            if (op.text) cmds.push({ kind: 'text', x, y, text: op.text, alt: true, centerWidth: 0 });
            break;
        }
        break;
      }
    }
  }
  return cmds;
}
