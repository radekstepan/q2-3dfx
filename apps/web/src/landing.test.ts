// Landing overlay helpers: pure label + headless no-ops.
import { describe, expect, it } from 'vitest';
import {
  attachLanding,
  cachedButtonLabel,
  hideLanding,
  isLandingVisible,
  setCachedAvailable,
  setLandingBusy,
  setLandingStatus,
  showLanding,
} from './landing.js';

describe('landing helpers', () => {
  it('labels the cached continue button', () => {
    expect(cachedButtonLabel('pak0.pak', 42)).toBe('continue pak0.pak · 42 lumps');
  });

  it('is headless-safe without a DOM', () => {
    expect(typeof document).toBe('undefined');
    expect(isLandingVisible()).toBe(false);
    expect(() => {
      showLanding();
      hideLanding();
      setLandingStatus('hi');
      setLandingBusy(true);
      setLandingBusy(false);
      setCachedAvailable('continue x');
      setCachedAvailable(null);
    }).not.toThrow();
    expect(attachLanding({ onDemo: () => undefined, onPick: () => undefined, onDevroom: () => undefined, onCached: () => undefined })()).toBeUndefined();
  });
});
