import { describe, expect, it } from 'vitest';
import { Host } from './index.js';
import { NullRefresh } from '@q2/renderer-api';

describe('host loop', () => {
  it('boots, ticks 10Hz snapshots, and renders a frame', () => {
    const host = new Host({ refresh: new NullRefresh(), width: 64, height: 48 });
    host.frame(0);
    const stats = host.frame(250);
    expect(stats.pixels).toBe(64 * 48);
    // Two 10Hz snapshots after 250ms -> interpolation has a pair.
    expect(host.predictor.prev).not.toBeNull();
    expect(host.predictor.next).not.toBeNull();
    expect(host.lastCmd).not.toBeNull();
  });

  it('ingested snapshots flow into render entities', () => {
    const host = new Host({ refresh: new NullRefresh(), width: 32, height: 32 });
    host.ingestSnapshot({ serverTime: 1.0, entities: [{ id: 1, origin: [5, 5, 0], velocity: [0, 0, 0] }] });
    host.ingestSnapshot({ serverTime: 1.1, entities: [{ id: 1, origin: [15, 5, 0], velocity: [0, 0, 0] }] });
    const ents = host.predictor.renderEntities(1.1, 1);
    expect(ents[0]!.id).toBe(1);
  });
});
