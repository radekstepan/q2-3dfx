// R9F-9 — driver loop-channel sync on real base1 (Q2_PAK-gated).
//
// The server keeps prestarted/toggled speaker loops as persistent
// loop:true records in st.sounds (never drained, never 5s-pruned); each
// driver step reconciles them to loop:true Mixer channels (start new,
// refresh positions, stop vanished) without touching one-shot mixing or
// the 0.05 master scale point. Skips cleanly without Q2_PAK.
import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars } from '@q2/config';
import { fireTargets } from '@q2/server';
import { spawnEdict } from '@q2/game';
import { v3 } from '@q2/math';
import type { UserCmdT } from '@q2/input';
import { bootPlay } from './play.js';

const WEB_Q2_PAK = process.env.Q2_PAK;

function neutralCmd(): UserCmdT {
  return { msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

async function bootBase1() {
  const { readFileSync } = await import('fs');
  const raw = readFileSync(WEB_Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const { ingestPak } = await import('./pak.js');
  return bootPlay({ width: 96, height: 72, pak: ingestPak(buf) });
}

afterEach(() => {
  resetCVars();
});

describe.runIf(!!WEB_Q2_PAK)('R9F-9 loop channels on real base1', () => {
  it('prestarted speakers become loop channels; toggle removes and re-adds', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    for (let i = 0; i < 3; i++) driver.step(neutralCmd(), 0.1);
    // Prestarted loop ambience reconciles to Mixer loop channels.
    const keys = driver.loopChannelKeys;
    expect(keys.length).toBeGreaterThan(0);
    const ambient = keys.find((k) => k.startsWith('world/amb'))!;
    expect(ambient).toBeDefined();
    const ambientName = ambient.slice(0, ambient.indexOf('@'));
    // Loop records never ride the one-shot path (no drain, no heardSounds).
    expect(driver.heardSounds).not.toContain(ambientName);
    // Audibility: standing on a loop record makes its channel loud.
    const rec = driver.server.sounds.find((s) => s.loop === true)!;
    expect(rec).toBeDefined();
    driver.pm.origin = v3(rec.pos[0], rec.pos[1], rec.pos[2]);
    driver.pm.velocity = v3();
    driver.step(neutralCmd(), 0.1);
    const key = `${rec.name}@${rec.pos[0]},${rec.pos[1]},${rec.pos[2]}`;
    expect(driver.loopChannelKeys).toContain(key);
    const hit = driver.mixer.mix().find((c) => c.loop === true && c.name === rec.name);
    expect(hit).toBeDefined();
    expect((hit!.left + hit!.right) / 2).toBeGreaterThan(0.01);
    // Single 0.05 scale point holds across one-shots and loops alike.
    for (const c of driver.mixer.mix()) {
      expect(c.left).toBeLessThanOrEqual(0.0500001);
      expect(c.right).toBeLessThanOrEqual(0.0500001);
    }
    // Toggle-off/on: fire a named looped speaker that no func_timer drives
    // (timer cadence would race the re-add), double-fire restores the set.
    // fireTargets is the direct use path (C G_UseTargets → Use_Target_Speaker);
    // SV_UseTargetname does not reach speakers (movers/relays/timers only).
    const timerTargets = new Set(driver.server.timers.map((t) => t.target));
    const loopedNames = [...driver.server.speakers.entries()]
      .filter(([, list]) => list.some((sp) => sp.looped))
      .map(([name]) => name);
    expect(loopedNames.length).toBeGreaterThan(0);
    const target = loopedNames.find((n) => !timerTargets.has(n)) ?? loopedNames[0]!;
    const snapshot = [...driver.loopChannelKeys].sort();
    const use = (): void => {
      fireTargets(driver.server, spawnEdict({ classname: 'trigger_once', target }));
    };
    use();
    driver.step(neutralCmd(), 0.1);
    const toggled = [...driver.loopChannelKeys].sort();
    expect(toggled).not.toEqual(snapshot);
    use();
    driver.step(neutralCmd(), 0.1);
    expect([...driver.loopChannelKeys].sort()).toEqual(snapshot);
  });
});
