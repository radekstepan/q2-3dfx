// Unit tests for the §4 dependency checker (pure checkGraph + edge cases).
import { describe, expect, it } from 'vitest';
import { ALLOW, checkGraph, type DepEdge } from './check-deps.js';

const edge = (from: string, to: string, file = 'packages/x/src/a.ts'): DepEdge => ({ from, to, file });

describe('checkGraph allowlist', () => {
  it('passes the §4-sanctioned backbone', () => {
    expect(checkGraph([
      edge('formats', 'math'),
      edge('bsp', 'formats'),
      edge('sw-renderer', 'bsp'),
      edge('renderer-api', 'math'),
      edge('game', 'bsp'),
      edge('server', 'game'),
      edge('client', 'game'),
      edge('host', 'client'),
      edge('host', 'server'),
      edge('app:web', 'host'),
    ])).toEqual([]);
  });

  it('passes the documented reality exceptions', () => {
    expect(checkGraph([
      edge('sw-renderer', 'renderer-api'), // implements Refresh
      edge('game', 'formats'), // asset data
      edge('server', 'filesystem'), // map loading
      edge('server', 'math'), // sim vec math
      edge('host', 'input'), // loop wiring
      edge('host', 'sound'),
      edge('host', 'renderer-api'),
      edge('testkit', 'voodoo'), // harness, anything but apps
      edge('tool:bench', 'sw-renderer'),
    ])).toEqual([]);
  });

  it('fails on new cross-package edges', () => {
    const bad = checkGraph([edge('game', 'client'), edge('server', 'host')]);
    expect(bad.length).toBe(2);
    expect(bad[0]).toContain('BRAIN.md §4 allows');
  });

  it('fails when anything imports from apps/* (both directions)', () => {
    const bad = checkGraph([
      edge('game', 'app:web', 'packages/game/src/a.ts'),
      edge('app:web', 'app:devtools', 'apps/web/src/a.ts'),
    ]);
    expect(bad.length).toBe(2);
    expect(bad[0]).toContain('nothing may import from apps/*');
  });

  it('fails on self-imports and unknown packages', () => {
    expect(checkGraph([edge('game', 'game')]).length).toBe(1);
    expect(checkGraph([edge('game', 'nope')]).length).toBe(1);
  });

  it('every real package has an allowlist entry', () => {
    for (const p of ['config', 'math', 'filesystem', 'formats', 'bsp', 'sw-renderer', 'voodoo',
      'renderer-api', 'game', 'server', 'client', 'host', 'testkit', 'input', 'sound']) {
      expect(ALLOW[p]).toBeDefined();
    }
  });
});
