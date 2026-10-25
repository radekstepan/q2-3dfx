// @q2/client/statusbar — statusbar layout string parsing (M6.1).
//
// The server ships the HUD layout in configstring CS_STATUSBAR: a small
// script (`xv 32 yv 144 pic 0 client 0 num 3 10 ...`) executed each frame.
// This module tokenizes + parses it into ops; the web HUD executes the ops.

/** Q2 configstring index carrying the statusbar layout. */
export const CS_STATUSBAR = 5;

export type StatusOp =
  | { op: 'pos'; x: number; y: number }
  | { op: 'pic'; index: number }
  | { op: 'client'; index: number }
  | { op: 'num'; width: number; index: number }
  | { op: 'hnum' }
  | { op: 'anum' }
  | { op: 'rnum' }
  | { op: 'stat_string'; index: number }
  | { op: 'cstring'; text: string }
  | { op: 'string'; text: string }
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
  let dirty = false;
  const flush = (): void => {
    if (dirty) {
      ops.push({ op: 'pos', x, y });
      dirty = false;
    }
  };
  let i = 0;
  while (i < toks.length) {
    const t = toks[i++]!;
    switch (t) {
      case 'xl': x = num(toks[i++], 'xl'); dirty = true; break;
      case 'xr': x = num(toks[i++], 'xr'); dirty = true; break;
      case 'xv': x = num(toks[i++], 'xv'); dirty = true; break;
      case 'yb': y = num(toks[i++], 'yb'); dirty = true; break;
      case 'yt': y = num(toks[i++], 'yt'); dirty = true; break;
      case 'yv': y = num(toks[i++], 'yv'); dirty = true; break;
      case 'pic': flush(); ops.push({ op: 'pic', index: num(toks[i++], 'pic') }); break;
      case 'client': flush(); ops.push({ op: 'client', index: num(toks[i++], 'client') }); break;
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
