import { describe, expect, it } from 'vitest';
import { Host } from '@q2/host';
import { NullRefresh } from '@q2/renderer-api';
import { bootWeb } from './index.js';
import { ingestPak, makePakForTest, pakHasMaps } from './test-helpers.js';

describe('web app shell (headless, DOM-isolated)', () => {
  it('boots the devroom to a first frame with no pak', () => {
    const boot = bootWeb({ width: 64, height: 48 });
    expect(boot.source).toBe('devroom');
    expect(boot.pixels).toBe(64 * 48);
    expect(boot.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('pak drop path validates client-side and reports entries', () => {
    const pak = ingestPak(makePakForTest());
    expect(pakHasMaps(pak)).toBe(true);
    const boot = bootWeb({ width: 64, height: 48, pak });
    expect(boot.source).toBe('pak');
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
