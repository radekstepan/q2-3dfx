// q2ts-web soak hook tests (GPU-PROOF-5, measurement only).
//
// Pins the URL-param autoboot contract WITHOUT a DOM: param parsing, cvar
// override parsing/application, status collection, GL probe headless-safety,
// and a Q2_PAK-gated soak-geometry boot (base1 at 640x480 through bootPlay —
// the same call the soak page makes). No renderer/backend/policy changes.
import { afterEach, describe, expect, it } from 'vitest';
import { getCVarString, resetCVars } from '@q2/config';
import {
  applySoakCvars,
  collectSoakStatus,
  parseCvarOverrides,
  parseSoakParams,
  probeGlRenderer,
  readSoakCvarSnapshot,
  SOAK_CVAR_SNAPSHOT_KEYS,
  SOAK_HEIGHT,
  SOAK_WIDTH,
} from './soak.js';
import { bootPlay } from './play.js';
import { ingestPak } from './pak.js';

afterEach(() => {
  resetCVars();
});

describe('soak param parsing', () => {
  it('returns null without q2soak=1 (normal boot untouched)', () => {
    expect(parseSoakParams('')).toBeNull();
    expect(parseSoakParams('?q2pak=http://x/pak&q2renderer=software')).toBeNull();
    expect(parseSoakParams('?q2soak=0&q2pak=http://x/pak&q2renderer=software')).toBeNull();
  });

  it('returns null when the pak URL is missing', () => {
    expect(parseSoakParams('?q2soak=1&q2renderer=software')).toBeNull();
    expect(parseSoakParams('?q2soak=1&q2pak=&q2renderer=software')).toBeNull();
  });

  it('returns null for an unknown renderer (fail closed to normal boot)', () => {
    expect(parseSoakParams('?q2soak=1&q2pak=http://x/pak&q2renderer=vulkan')).toBeNull();
  });

  it('parses a full soak query', () => {
    const p = parseSoakParams('?q2pak=http%3A%2F%2Fx%2Fpak&q2renderer=webgl2-experimental&q2soak=1&q2cvars=vd_lodbias%3A-0.35%3Bvd_gamma%3A1.3');
    expect(p).not.toBeNull();
    expect(p!.pakUrl).toBe('http://x/pak');
    expect(p!.renderer).toBe('webgl2-experimental');
    expect(p!.cvars).toEqual({ vd_lodbias: '-0.35', vd_gamma: '1.3' });
  });

  it('defaults the renderer to software when absent', () => {
    const p = parseSoakParams('?q2soak=1&q2pak=http://x/pak');
    expect(p!.renderer).toBe('software');
    expect(p!.cvars).toEqual({});
  });
});

describe('soak cvar overrides', () => {
  it('parses key:value pairs and skips malformed entries', () => {
    expect(parseCvarOverrides(null)).toEqual({});
    expect(parseCvarOverrides('')).toEqual({});
    expect(parseCvarOverrides('vd_gamma:1.3;vd_lodbias:-0.35')).toEqual({
      vd_gamma: '1.3',
      vd_lodbias: '-0.35',
    });
    expect(parseCvarOverrides('bogus;no-colon:;9bad:1;vd_gamma:')).toEqual({});
    expect(parseCvarOverrides('vd_rgbmaxdelta:8,8,8')).toEqual({ vd_rgbmaxdelta: '8,8,8' });
  });

  it('applySoakCvars pins 640x480 + renderer + overrides', () => {
    const p = parseSoakParams('?q2soak=1&q2pak=http://x/pak&q2renderer=software&q2cvars=vd_gamma:1.3')!;
    const { applied, skipped } = applySoakCvars(p);
    expect(skipped).toEqual([]);
    expect(applied).toContain('vid_resolution');
    expect(applied).toContain('vid_renderer');
    expect(applied).toContain('vd_gamma');
    expect(getCVarString('vid_resolution')).toBe('640x480');
    expect(getCVarString('vid_renderer')).toBe('software');
    expect(getCVarString('vd_gamma')).toBe('1.3');
  });

  it('collectSoakStatus builds the pre-boot record', () => {
    const p = parseSoakParams('?q2soak=1&q2pak=http://x/pak&q2renderer=software')!;
    const st = collectSoakStatus(p, 'ANGLE (AMD, test)', 1234.5);
    expect(st).toEqual({
      soak: true,
      booted: false,
      requestedRenderer: 'software',
      actualRenderer: 'software',
      warning: null,
      width: SOAK_WIDTH,
      height: SOAK_HEIGHT,
      glRenderer: 'ANGLE (AMD, test)',
      error: null,
      t0: 1234.5,
    });
    expect(SOAK_WIDTH).toBe(640);
    expect(SOAK_HEIGHT).toBe(480);
  });

  it('probeGlRenderer is headless-safe (null under vitest, never throws)', () => {
    expect(typeof document).toBe('undefined');
    let s: string | null = 'unset';
    expect(() => {
      s = probeGlRenderer();
    }).not.toThrow();
    expect(s).toBeNull();
  });

  it('readSoakCvarSnapshot reads the pinned keys without throwing', () => {
    const snap = readSoakCvarSnapshot(SOAK_CVAR_SNAPSHOT_KEYS);
    expect(snap['vid_renderer']).toBe(getCVarString('vid_renderer'));
    expect(Object.keys(snap)).toHaveLength(SOAK_CVAR_SNAPSHOT_KEYS.length);
  });
});

const WEB_Q2_PAK = process.env.Q2_PAK;

describe.runIf(!!WEB_Q2_PAK)('soak-geometry boot (Q2_PAK)', () => {
  it('boots base1 at soak geometry through the production path', async () => {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    const pak = ingestPak(buf);
    for (const renderer of ['software'] as const) {
      const boot = bootPlay({ width: SOAK_WIDTH, height: SOAK_HEIGHT, renderer, pak });
      expect(boot.host.fb.width).toBe(SOAK_WIDTH);
      expect(boot.host.fb.height).toBe(SOAK_HEIGHT);
      expect(boot.source).toBe('pak');
      expect(boot.renderer).toBe(renderer);
    }
    resetCVars();
  });
});
