import { describe, expect, it } from 'vitest';
import {
  clearConsoleLog,
  getConsoleLines,
  pushConsoleLog,
  renderConsoleLines,
  resetConsoleLog,
  setModeReadout,
  MAX_CONSOLE_LINES,
} from './dom.js';

describe('retro console strip (headless, DOM-isolated)', () => {
  it('pushes timestamped lines with kinds, oldest-first', () => {
    resetConsoleLog();
    const a = pushConsoleLog('execing config.cfg', 'info');
    const b = pushConsoleLog('vid_restart · restarting video subsystem', 'warn');
    expect(a.id + 1).toBe(b.id);
    expect(a.t).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    const lines = getConsoleLines();
    expect(lines.map((l) => l.text)).toEqual([
      'execing config.cfg',
      'vid_restart · restarting video subsystem',
    ]);
    expect(lines.map((l) => l.kind)).toEqual(['info', 'warn']);
  });

  it('caps the buffer at MAX_CONSOLE_LINES (retro 40-line strip)', () => {
    resetConsoleLog();
    expect(MAX_CONSOLE_LINES).toBe(40);
    for (let i = 0; i < MAX_CONSOLE_LINES + 10; i++) pushConsoleLog(`line ${i}`, 'cmd');
    const lines = getConsoleLines();
    expect(lines.length).toBe(MAX_CONSOLE_LINES);
    expect(lines[0]!.text).toBe('line 10');
    expect(lines[lines.length - 1]!.text).toBe(`line ${MAX_CONSOLE_LINES + 9}`);
  });

  it('clear empties the buffer; render is headless-safe', () => {
    resetConsoleLog();
    pushConsoleLog('hello', 'ok');
    expect(getConsoleLines().length).toBe(1);
    expect(renderConsoleLines()).toBe(1);
    clearConsoleLog();
    expect(getConsoleLines()).toEqual([]);
    expect(renderConsoleLines()).toBe(0);
  });

  it('setModeReadout is a headless no-op (DOM-guarded)', () => {
    expect(typeof document).toBe('undefined');
    expect(() => setModeReadout('320×240 · software', 0)).not.toThrow();
    expect(() => setModeReadout('640×480 · voodoo', 3)).not.toThrow();
  });
});
