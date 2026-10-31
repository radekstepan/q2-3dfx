// @q2/client/screens — level-completion, scoreboard, centerprint and
// inventory layout semantics (RELEASE-6).
//
// Ground truth: `game/p_hud.c` (`BeginIntermission`, `MoveClientToIntermission`,
// `DeathmatchScoreboardMessage`), `client/cl_scrn.c` (`SCR_DrawCenterString`)
// and `client/cl_inv.c` (`CL_DrawInventory`). Single-player completion shows
// no scoreboard at all: `BeginIntermission` sets `exitintermission = 1`
// immediately when the next map has no `*` (unit boundary), so the level ends
// on the centerprinted message and the next map loads. Deathmatch/coop move
// every client to the intermission spot and unicast the scoreboard layout.

/** Seconds before clients may leave the intermission (`p_client.c`). */
export const INTERMISSION_MIN_TIME = 5;

/** End-of-unit plaque (320x240, full-screen). */
export const VICTORY_PIC = 'victory';
export const VICTORY_W = 320;
export const VICTORY_H = 240;

/** Whether a single-player map change shows a scoreboard (`BeginIntermission`). */
export function showsIntermissionScoreboard(nextMap: string): boolean {
  return nextMap.includes('*');
}

// ---------------------------------------------------------------------------
// Deathmatch/coop scoreboard
// ---------------------------------------------------------------------------

/** One ranked scoreboard row. */
export interface ScoreEntry {
  readonly slot: number;
  readonly score: number;
  readonly ping: number;
  /** Seconds since entering the level (`(levelframenum-enterframe)/600`). */
  readonly time: number;
  /** Row belongs to the viewing client (`tag1` dogtag). */
  readonly self: boolean;
  /** Row belongs to the killer (`tag2` dogtag). */
  readonly killer: boolean;
}

/**
 * Rank entries by score, descending, stable on ties (id's insertion sort),
 * capped at 12 rows (`DeathmatchScoreboardMessage`).
 */
export function sortScoreboard(entries: readonly ScoreEntry[]): ScoreEntry[] {
  const sorted: ScoreEntry[] = [];
  for (const e of entries) {
    let j = 0;
    while (j < sorted.length && e.score <= sorted[j]!.score) j++;
    sorted.splice(j, 0, e);
  }
  return sorted.slice(0, 12);
}

/** Scoreboard cell origin: two columns of six, 160px apart, 32px rows from y=32. */
export function scoreCell(row: number): { x: number; y: number } {
  return { x: row >= 6 ? 160 : 0, y: 32 + 32 * (row % 6) };
}

/** Dogtag pic for a row (`tag1` self wins over `tag2` killer, like id). */
export function scoreTag(e: ScoreEntry): 'tag1' | 'tag2' | null {
  if (e.self) return 'tag1';
  if (e.killer) return 'tag2';
  return null;
}

/**
 * Build the scoreboard layout string id unicasts (`svc_layout`). Each row is
 * an optional `tag1`/`tag2` dogtag pic plus a `client` block the executor
 * draws with the client's name, score, ping, time and icon.
 */
export function buildScoreboardLayout(entries: readonly ScoreEntry[]): string {
  const rows = sortScoreboard(entries);
  let s = '';
  rows.forEach((e, i) => {
    const { x, y } = scoreCell(i);
    const tag = scoreTag(e);
    if (tag) s += `xv ${x + 32} yv ${y} picn ${tag} `;
    s += `client ${x} ${y} ${e.slot} ${e.score} ${e.ping} ${e.time} `;
  });
  return s;
}

// ---------------------------------------------------------------------------
// Centerprint (level-completion / finale text)
// ---------------------------------------------------------------------------

/** Split a centerprint string into lines (`\n`-separated, like id). */
export function centerPrintLines(text: string): string[] {
  return text.split('\n');
}

/** One placed centerprint line. */
export interface CenterLine {
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

/**
 * Place centerprint lines (`SCR_DrawCenterString`): 8px conchars rows,
 * horizontally centered per line, at 35% screen height for short messages
 * (<=4 lines) and y=48 for the finale-style long scroll.
 */
export function centerPrintPlacement(text: string, screenW: number, screenH: number): CenterLine[] {
  const lines = centerPrintLines(text);
  const y0 = lines.length <= 4 ? Math.trunc(screenH * 0.35) : 48;
  return lines.map((line, i) => ({
    x: Math.trunc((screenW - line.length * 8) / 2),
    y: y0 + i * 8,
    text: line,
  }));
}

// ---------------------------------------------------------------------------
// Inventory screen (`CL_DrawInventory`)
// ---------------------------------------------------------------------------

/** Rows visible without scrolling. */
export const DISPLAY_ITEMS = 17;

/** Inventory background pic (256x192). */
export const INVENTORY_PIC = 'inventory';
export const INVENTORY_W = 256;
export const INVENTORY_H = 192;

export const INVENTORY_HEADER_1 = 'hotkey ### item';
export const INVENTORY_HEADER_2 = '------ --- ----';

/** One carried item row (the integrator resolves key bindings). */
export interface InventoryItem {
  /** Item index (`cl.inventory[i]`, selected highlighted via `STAT_SELECTED_ITEM`). */
  readonly index: number;
  readonly count: number;
  readonly name: string;
  readonly bind: string;
}

/** One placed inventory text row. */
export interface InventoryRow {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  /** Non-selected rows render high-bit (`SetStringHighBit`, green in conchars). */
  readonly alt: boolean;
  /** Blinking `char 15` cursor left of the selected row. */
  readonly cursor: boolean;
}

/** Placed inventory screen: background pic origin plus header and item rows. */
export interface InventoryLayout {
  readonly picX: number;
  readonly picY: number;
  readonly headerX: number;
  readonly headerY: number;
  readonly rows: InventoryRow[];
}

/** `%6s %3i %s` row text (`CL_DrawInventory`). */
export function formatInventoryRow(bind: string, count: number, name: string): string {
  return `${bind.padStart(6, ' ')} ${`${Math.trunc(count)}`.padStart(3, ' ')} ${name}`;
}

/**
 * Lay out the inventory screen: 256x192 `inventory` pic centered, header
 * rows, and up to 17 item rows scrolled so the selection stays visible. The
 * selected row blinks its cursor at 10 Hz (`(realtime*10)&1`).
 */
export function layoutInventory(
  items: readonly InventoryItem[],
  selected: number,
  realtime: number,
  screenW: number,
  screenH: number,
): InventoryLayout {
  let selectedNum = 0;
  items.forEach((item, n) => {
    if (item.index === selected) selectedNum = n;
  });
  let top = selectedNum - Math.trunc(DISPLAY_ITEMS / 2);
  if (items.length - top < DISPLAY_ITEMS) top = items.length - DISPLAY_ITEMS;
  if (top < 0) top = 0;

  const picX = Math.trunc((screenW - INVENTORY_W) / 2);
  // id centers a 240-tall box and draws the 192-tall pic 8px into it.
  const boxY = Math.trunc((screenH - 240) / 2);
  const headerX = picX + 24;
  const headerY = boxY + 24;
  const rows: InventoryRow[] = [];
  const last = Math.min(items.length, top + DISPLAY_ITEMS);
  for (let n = top; n < last; n++) {
    const item = items[n]!;
    const y = headerY + 16 + (n - top) * 8;
    const isSelected = item.index === selected;
    rows.push({
      x: headerX,
      y,
      text: formatInventoryRow(item.bind, item.count, item.name),
      alt: !isSelected,
      cursor: isSelected && (Math.trunc(realtime * 10) & 1) === 1,
    });
  }
  return { picX, picY: boxY + 8, headerX, headerY, rows };
}
