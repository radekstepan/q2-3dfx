// @q2/config — RELEASE-10: renderer capability mapping tests.
//
// Pins `RENDERER_CVAR_SUPPORT` / `isCVarSupportedBy` / `supportReason` /
// `resolveEffectiveRenderer` in `index.ts`.
//
// Panel cvar lists below mirror `apps/web/src/dom.ts` BY VALUE (config is a
// leaf: nothing may import from `apps/*`, so the union is pinned here and the
// comment cites the source). If the panel gains a cvar, add it to the table
// (or rely on the unknown-cvar shared default) and extend these lists.
import { describe, expect, it } from 'vitest';
import {
  type EffectiveRenderer,
  isCVarSupportedBy,
  RENDERER_CVAR_SUPPORT,
  resolveEffectiveRenderer,
  supportReason,
  UNKNOWN_CVAR_SUPPORT_REASON,
} from './index.js';

// Mirror of CVAR_OPTIONS keys in apps/web/src/dom.ts.
const PANEL_OPTION_CVARS: readonly string[] = [
  'vid_renderer',
  'vid_resolution',
  'skill',
  'map_source',
  'sw_workers',
  'r_brightness',
  'vd_gamma',
  'vd_dithermode',
  'vd_reconmode',
  'vd_maxtexsize',
  'vd_zbits',
];

// Mirror of CHECKBOX_CVARS in apps/web/src/dom.ts.
const PANEL_CHECKBOX_CVARS: readonly string[] = [
  'cl_showfps',
  'cl_showpos',
  'vd_16bit',
  'vd_dither',
  'vd_postfilter',
  'vd_bilinear',
  'vd_mipdither',
  'vd_fog',
  'vd_palettetex',
  'vd_overbright',
  'r_drawworld',
  'r_translucency',
  'sw_stipplealpha',
  'cl_predict',
  'cl_interp',
  'sw_wasm',
  'sw_accum',
];

// Remaining registered text cvars reachable in the panel via listCVars().
const PANEL_TEXT_CVARS: readonly string[] = [
  'vd_lodbias',
  'vd_rgbmaxdelta',
  'sw_gamma',
  's_volume',
  'sensitivity',
  'm_yaw',
  'm_pitch',
];

const ALL_PANEL_CVARS: readonly string[] = [
  ...PANEL_OPTION_CVARS,
  ...PANEL_CHECKBOX_CVARS,
  ...PANEL_TEXT_CVARS,
];

const RENDERERS: readonly EffectiveRenderer[] = ['software', 'webgl2-experimental'];

describe('RENDERER_CVAR_SUPPORT (RELEASE-10 capability mapping)', () => {
  it('classifies every panel cvar from dom.ts CVAR_OPTIONS/CHECKBOX_CVARS (+ text cvars)', () => {
    expect(new Set(ALL_PANEL_CVARS).size).toBe(ALL_PANEL_CVARS.length);
    for (const name of ALL_PANEL_CVARS) {
      const entry = RENDERER_CVAR_SUPPORT[name];
      expect(entry, name).toBeDefined();
      expect(typeof entry!.software, name).toBe('boolean');
      expect(typeof entry!.webgl2, name).toBe('boolean');
    }
  });

  it('webgl-only Voodoo effects: software ignores every vd_* that takes pixel effect', () => {
    const webglOnly = [
      'vd_16bit', 'vd_dither', 'vd_postfilter', 'vd_bilinear', 'vd_mipdither',
      'vd_fog', 'vd_gamma', 'vd_lodbias', 'vd_overbright', 'vd_maxtexsize',
      'vd_zbits', 'vd_dithermode', 'vd_reconmode', 'vd_rgbmaxdelta',
    ];
    for (const name of webglOnly) {
      expect(isCVarSupportedBy(name, 'software'), name).toBe(false);
      expect(isCVarSupportedBy(name, 'webgl2-experimental'), name).toBe(true);
    }
  });

  it('software-only span/display controls: GPU path ignores them', () => {
    const softwareOnly = [
      'sw_workers', 'sw_wasm', 'sw_accum',
      'r_translucency', 'sw_stipplealpha', 'r_brightness',
    ];
    for (const name of softwareOnly) {
      expect(isCVarSupportedBy(name, 'software'), name).toBe(true);
      expect(isCVarSupportedBy(name, 'webgl2-experimental'), name).toBe(false);
    }
  });

  it('decorative on both renderers: sw_gamma, r_drawworld, vd_palettetex, cl_interp', () => {
    for (const name of ['sw_gamma', 'r_drawworld', 'vd_palettetex', 'cl_interp']) {
      expect(isCVarSupportedBy(name, 'software'), name).toBe(false);
      expect(isCVarSupportedBy(name, 'webgl2-experimental'), name).toBe(false);
    }
  });

  it('shared on both renderers: backend select, boot, HUD, predict, audio/input', () => {
    const shared = [
      'vid_renderer', 'vid_resolution', 'skill', 'map_source',
      'cl_showfps', 'cl_showpos', 'cl_predict',
      's_volume', 'sensitivity', 'm_yaw', 'm_pitch',
    ];
    for (const name of shared) {
      expect(isCVarSupportedBy(name, 'software'), name).toBe(true);
      expect(isCVarSupportedBy(name, 'webgl2-experimental'), name).toBe(true);
    }
  });

  it('unknown cvars default to supported/shared (never brick the panel)', () => {
    for (const renderer of RENDERERS) {
      expect(isCVarSupportedBy('brand_new_cvar', renderer)).toBe(true);
      expect(isCVarSupportedBy('', renderer)).toBe(true);
      expect(supportReason('brand_new_cvar', renderer)).toBe(UNKNOWN_CVAR_SUPPORT_REASON);
    }
  });

  it('fallback counts as software: incapable-GPU request behaves exactly like software', () => {
    expect(resolveEffectiveRenderer('webgl2-experimental', false)).toBe('software');
    expect(resolveEffectiveRenderer('webgl2-experimental', true)).toBe('webgl2-experimental');
    expect(resolveEffectiveRenderer('software', false)).toBe('software');
    expect(resolveEffectiveRenderer('voodoo', true)).toBe('software');
    expect(resolveEffectiveRenderer('bogus-id', true)).toBe('software');
    const fallback: EffectiveRenderer = resolveEffectiveRenderer('webgl2-experimental', false);
    for (const name of [...ALL_PANEL_CVARS, 'some_future_cvar']) {
      expect(isCVarSupportedBy(name, fallback)).toBe(isCVarSupportedBy(name, 'software'));
      expect(supportReason(name, fallback)).toBe(supportReason(name, 'software'));
    }
  });

  it('reasons are non-empty for every entry, renderer, and unknown cvar', () => {
    expect(UNKNOWN_CVAR_SUPPORT_REASON.length).toBeGreaterThan(0);
    for (const [name, entry] of Object.entries(RENDERER_CVAR_SUPPORT)) {
      expect(entry.reason.length, name).toBeGreaterThan(0);
      for (const renderer of RENDERERS) {
        const reason = supportReason(name, renderer);
        expect(typeof reason, `${name}/${renderer}`).toBe('string');
        expect(reason.length, `${name}/${renderer}`).toBeGreaterThan(0);
      }
    }
  });

  it('never throws on hostile input', () => {
    for (const renderer of RENDERERS) {
      expect(() => isCVarSupportedBy('__proto__', renderer)).not.toThrow();
      expect(() => supportReason('__proto__', renderer)).not.toThrow();
      expect(typeof supportReason('__proto__', renderer)).toBe('string');
    }
    expect(() => resolveEffectiveRenderer('', false)).not.toThrow();
    expect(resolveEffectiveRenderer('', false)).toBe('software');
  });
});
