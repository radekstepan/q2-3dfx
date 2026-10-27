// devtools M4.1 side-by-side review helper tests.
import { describe, expect, it } from 'vitest';
import {
  captureChecklist,
  reviewLine,
  reviewReportHtml,
  summarizeReview,
} from './sidebyside.js';

const px = (r: number, g: number, b: number): number => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;

describe('summarizeReview', () => {
  it('passes identical frames, flags missing references as pending', () => {
    const a = new Uint32Array([px(1, 2, 3)]);
    const same = summarizeReview('v', a, new Uint32Array(a));
    expect(same.pass).toBe(true);
    expect(same.referencePresent).toBe(true);
    const missing = summarizeReview('v', a, null);
    expect(missing.pass).toBe(false);
    expect(missing.referencePresent).toBe(false);
    expect(reviewLine(missing)).toContain('pending');
  });

  it('fails past the 0.5% / 1-LSB tolerance', () => {
    const n = 1000;
    const a = new Uint32Array(n).fill(px(50, 50, 50));
    const b = new Uint32Array(n).fill(px(50, 50, 50));
    for (let i = 0; i < 6; i++) b[i] = px(60, 50, 50);
    const s = summarizeReview('v', a, b);
    expect(s.diff).toBe(6);
    expect(s.pass).toBe(false);
    expect(reviewLine(s)).toContain('FAIL');
  });

  it('renders a standalone HTML report', () => {
    const html = reviewReportHtml([summarizeReview('v', new Uint32Array([1]), new Uint32Array([1]))]);
    expect(html).toContain('M4.1 Voodoo3 side-by-side review');
    expect(html).toContain('PASS');
  });

  it('checklist points at the capture doc, not a checkbox', () => {
    const list = captureChecklist();
    expect(list.length).toBeGreaterThan(0);
    expect(list.join('\n')).toContain('BRAIN.md §15');
  });
});
