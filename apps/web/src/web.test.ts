import { describe, expect, it } from 'vitest';
import { Host } from '@q2/host';
import { NullRefresh } from '@q2/renderer-api';
import { bootWeb } from './index.js';
import { ingestPak, makePakForTest, pakHasMaps } from './test-helpers.js';

describe('web app shell (headless, DOM-isolated)', () => {
  it('boots the devroom to a first frame with no pak', () => {
    const boot = bootWeb({ width: 64, height: 48 });
    expect(boot.source).toBe('devroom');
    // Real renderer: shaded span pixels (overdraw can exceed the area).
    expect(boot.pixels).toBeGreaterThan(0);
    expect(boot.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('pak drop path validates client-side and reports entries', () => {
    const pak = ingestPak(makePakForTest());
    expect(pakHasMaps(pak)).toBe(true);
    const boot = bootWeb({ width: 64, height: 48, pak });
    // Synthetic pak has no bootable base1.bsp: honest devroom fallback,
    // but the entry count is still reported.
    expect(boot.source).toBe('devroom');
    expect(boot.pakEntries).toBe(pak.entries.length);
  });

  it('host frame loop ticks the 10Hz server and renders stats', () => {
    const host = new Host({ refresh: new NullRefresh(), width: 64, height: 48 });
    const stats = host.frame(0);
    expect(stats.pixels).toBe(64 * 48);
    const later = host.frame(1000);
    expect(later.pixels).toBe(64 * 48);
  });
});

const WEB_Q2_PAK = process.env.Q2_PAK;

describe.runIf(!!WEB_Q2_PAK)('web app shell with real pak0.pak (Q2_PAK)', () => {
  it('ingests the full shareware pak client-side', async () => {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak, pakHasMaps } = await import('./pak.js');
    const pak = ingestPak(buf);
    const names = new Set(pak.entries.map((e) => e.name));
    console.log(
      `WIRE web ingest: entries=${pak.entries.length} hasMaps=${pakHasMaps(pak)} ` +
        `hasBase1=${names.has('maps/base1.bsp')}`,
    );
    expect(pak.entries.length).toBe(3307);
    expect(pakHasMaps(pak)).toBe(true);
    expect(names.has('maps/base1.bsp')).toBe(true);
  }, 120000);
});
