// @q2/client/console — in-game console with cvar get/set (M6.1).
// Wired to @q2/config; headless (the web shell draws it via hud.ts).
import { getCVar, listCVars, setCVarFromString } from '@q2/config';

export const CONSOLE_MAX_LINES = 256;

function splitArgs(line: string): string[] {
  const args: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuote) {
      if (c === '"') {
        args.push(cur);
        cur = '';
        inQuote = false;
      } else cur += c;
    } else if (c === '"') {
      inQuote = true;
    } else if (c === ' ' || c === '\t') {
      if (cur.length > 0) {
        args.push(cur);
        cur = '';
      }
    } else cur += c;
  }
  if (cur.length > 0) args.push(cur);
  return args;
}

export class GameConsole {
  lines: string[] = [];
  visible = false;

  print(text: string): void {
    for (const part of text.split('\n')) {
      this.lines.push(part);
      while (this.lines.length > CONSOLE_MAX_LINES) this.lines.shift();
    }
  }

  toggle(): void {
    this.visible = !this.visible;
  }

  /** Execute one console line. Returns output (also echoed via print). */
  exec(line: string): string {
    const trimmed = line.trim();
    if (!trimmed) return '';
    this.print(`]${trimmed}`);
    const [cmd = '', ...rest] = splitArgs(trimmed);
    const out = this.runCommand(cmd.toLowerCase(), rest);
    if (out) this.print(out);
    return out;
  }

  private runCommand(cmd: string, args: string[]): string {
    switch (cmd) {
      case 'help':
        return 'commands: help echo clear list get <cvar> set <cvar> <value> toggle <cvar>';
      case 'echo':
        return args.join(' ');
      case 'clear':
        this.lines = [];
        return '';
      case 'list': {
        const prefix = args[0]?.toLowerCase();
        const all = listCVars().filter((c) => !prefix || c.name.startsWith(prefix));
        return all.map((c) => `${c.name} = ${JSON.stringify(c.value)}`).join('\n');
      }
      case 'get': {
        const name = args[0];
        if (!name) return 'usage: get <cvar>';
        const v = getCVar(name);
        return v === undefined ? `unknown cvar "${name}"` : `${name} = ${JSON.stringify(v)}`;
      }
      case 'set': {
        const [name, ...valueParts] = args;
        if (!name || valueParts.length === 0) return 'usage: set <cvar> <value>';
        const v = setCVarFromString(name, valueParts.join(' '));
        return `${name} = ${JSON.stringify(v)}`;
      }
      case 'toggle': {
        const name = args[0];
        if (!name) return 'usage: toggle <cvar>';
        const cur = getCVar(name);
        if (typeof cur !== 'number' && typeof cur !== 'boolean') {
          return `cannot toggle non-numeric cvar "${name}"`;
        }
        const next = typeof cur === 'boolean' ? !cur : cur === 0 ? 1 : 0;
        setCVarFromString(name, String(next));
        return `${name} = ${JSON.stringify(next)}`;
      }
      default:
        return `unknown command "${cmd}" (try "help")`;
    }
  }
}
