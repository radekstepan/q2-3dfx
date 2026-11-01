// q2ts-web shared custom tooltip (RELEASE-10).
//
// Replaces native `title` popups on settings-panel rows/labels/controls with
// one width-limited tooltip node (`#q2-tooltip`, `role=tooltip`):
//   - wrapped text with a definite max-width (TOOLTIP_MAX_WIDTH CSS px,
//     clamped to viewport minus margins on narrow viewports/zoom),
//   - `position: fixed` under `document.body` so sidebar scroll containers
//     (`#q2-cvars-wrap` overflow) never clip it,
//   - flip-or-clamp placement near the hovered/focused anchor,
//   - mouse hover + keyboard focus triggers (including the disabled-control
//     wrappers, which are `tabindex=0` because the disabled native input
//     inside cannot take hover/focus), dismiss on leave/blur/Escape/scroll/
//     resize/panel rebuild, `aria-describedby` linkage, no focus trap.
//
// Browser-only behavior, headless-safe throughout: every DOM access is
// feature-detected, so Node/fake-DOM imports never throw. The pure placement
// math (`computeTooltipPosition`) needs no DOM at all and is unit-pinned.
// WebGL2 appearance is canonical in `webgl-renderer/appearance.ts`. No DOM
// needed here beyond feature-detected access.

/** Definite max width of the tooltip text (CSS px, before viewport clamp). */
export const TOOLTIP_MAX_WIDTH = 320;
/** Minimum gap kept to every viewport edge (also the anchor gap). */
export const TOOLTIP_MARGIN = 8;
/** DOM id of the singleton tooltip node (also the aria-describedby target). */
export const TOOLTIP_ID = 'q2-tooltip';
/** Attribute carrying the tooltip text on converted panel elements. */
export const TOOLTIP_TEXT_ATTR = 'data-q2-tip';

/** Minimal rect shape (DOMRect-compatible subset) for placement math. */
export interface TooltipAnchorRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
}

/** Viewport size (CSS px) for placement math. */
export interface TooltipViewport {
  width: number;
  height: number;
}

/** Measured tooltip size (CSS px) for placement math. */
export interface TooltipSize {
  width: number;
  height: number;
}

/** Placed top-left corner (CSS px, `position: fixed` coordinates). */
export interface TooltipPlacement {
  top: number;
  left: number;
}

/**
 * Pure placement: near the anchor, flipping or clamping at viewport edges.
 * Prefers below the anchor, left-aligned; flips above when the tooltip
 * would overflow the bottom edge; clamps horizontally (and finally
 * vertically) into [margin, viewport - margin]. Never throws, never
 * returns NaN (non-finite inputs fall back to the top-left margin corner).
 */
export function computeTooltipPosition(
  anchor: TooltipAnchorRect,
  tip: TooltipSize,
  viewport: TooltipViewport,
  margin: number = TOOLTIP_MARGIN,
): TooltipPlacement {
  const safe = (n: number, fallback: number): number =>
    Number.isFinite(n) ? n : fallback;
  const m = safe(margin, TOOLTIP_MARGIN) < 0 ? 0 : safe(margin, TOOLTIP_MARGIN);
  const vw = safe(viewport.width, 0);
  const vh = safe(viewport.height, 0);
  if (!(vw > 0) || !(vh > 0)) return { top: m, left: m };
  const tipW = Math.max(0, safe(tip.width, 0));
  const tipH = Math.max(0, safe(tip.height, 0));
  const aTop = safe(anchor.top, m);
  const aLeft = safe(anchor.left, m);
  const aBottom = safe(anchor.bottom, aTop);
  const gap = m;
  // Vertical: prefer below, flip above on bottom overflow, clamp otherwise.
  let top = aBottom + gap;
  if (top + tipH > vh - m) top = aTop - tipH - gap;
  if (top < m) top = m;
  if (top + tipH > vh - m) top = Math.max(m, vh - tipH - m);
  // Horizontal: left-align with the anchor, clamp into the viewport.
  let left = aLeft;
  if (left + tipW > vw - m) left = vw - tipW - m;
  if (left < m) left = m;
  return { top, left };
}

/**
 * Effective max width (CSS px): the definite cap bounded by the viewport
 * minus margins, so narrow viewports / high zoom never overflow sideways.
 */
export function tooltipMaxWidthFor(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return TOOLTIP_MAX_WIDTH;
  return Math.max(0, Math.min(TOOLTIP_MAX_WIDTH, viewportWidth - TOOLTIP_MARGIN * 2));
}

/** Read the tooltip text off an element (attribute wins, expando fallback). */
export function getTooltipText(el: unknown): string {
  if (!el || typeof el !== 'object') return '';
  try {
    const node = el as {
      getAttribute?: (k: string) => string | null;
    };
    if (typeof node.getAttribute === 'function') {
      const v = node.getAttribute(TOOLTIP_TEXT_ATTR);
      if (typeof v === 'string' && v.length > 0) return v;
    }
  } catch {
    /* fall through to the expando */
  }
  try {
    const v = (el as Record<string, unknown>)[TOOLTIP_TEXT_ATTR] ??
      (el as Record<string, unknown>)['__q2tip'];
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

/**
 * Convert an element to the custom tooltip: store the text off-band and
 * remove the native `title` popup source (attribute + expando) so converted
 * elements never show a duplicate native tooltip. Never throws.
 */
export function setTooltipText(el: unknown, text: string): void {
  if (!el || typeof el !== 'object') return;
  try {
    const node = el as {
      setAttribute?: (k: string, v: string) => void;
      removeAttribute?: (k: string) => void;
      title?: unknown;
    };
    try {
      node.setAttribute?.(TOOLTIP_TEXT_ATTR, text);
    } catch {
      /* fake node without setAttribute: expando below covers it */
    }
    (el as Record<string, unknown>)[TOOLTIP_TEXT_ATTR] = text;
    (el as Record<string, unknown>)['__q2tip'] = text;
    // Strip the native popup source. Real DOM: drop the attribute (the
    // custom-element wrappers mirror `.title` onto their inner native
    // control, so clearing the wrapper property clears the inner one too).
    try {
      node.removeAttribute?.('title');
    } catch {
      /* keep going: expando clear below */
    }
    try {
      if (typeof node.title === 'string') node.title = '';
    } catch {
      /* read-only title on some stubs */
    }
  } catch {
    /* non-object stub */
  }
}

/** True when the element still carries a native `title` popup source. */
export function hasNativeTitle(el: unknown): boolean {
  if (!el || typeof el !== 'object') return false;
  try {
    const node = el as {
      getAttribute?: (k: string) => string | null;
      title?: unknown;
    };
    if (typeof node.getAttribute === 'function') {
      try {
        const v = node.getAttribute('title');
        if (typeof v === 'string' && v.length > 0) return true;
      } catch {
        /* fall through to the expando */
      }
    }
    return typeof node.title === 'string' && node.title.length > 0;
  } catch {
    return false;
  }
}

// --- singleton node + show/hide ---------------------------------------------

type LooseNode = Record<string, unknown> & {
  addEventListener?: (type: string, fn: (e?: unknown) => void) => void;
  removeEventListener?: (type: string, fn: (e?: unknown) => void) => void;
  setAttribute?: (k: string, v: string) => void;
  removeAttribute?: (k: string) => void;
  getAttribute?: (k: string) => string | null;
  appendChild?: (c: unknown) => void;
};

function getDoc(): LooseNode | null {
  try {
    const g = globalThis as unknown as { document?: unknown };
    if (!g.document || typeof g.document !== 'object') return null;
    return g.document as LooseNode;
  } catch {
    return null;
  }
}

function readViewport(): TooltipViewport {
  try {
    const w = globalThis as unknown as {
      innerWidth?: unknown;
      innerHeight?: unknown;
    };
    if (typeof w.innerWidth === 'number' && typeof w.innerHeight === 'number') {
      return { width: w.innerWidth, height: w.innerHeight };
    }
  } catch {
    /* fall through */
  }
  try {
    const doc = getDoc();
    const de = doc?.['documentElement'] as { clientWidth?: unknown; clientHeight?: unknown } | undefined;
    if (typeof de?.clientWidth === 'number' && typeof de?.clientHeight === 'number') {
      return { width: de.clientWidth, height: de.clientHeight };
    }
  } catch {
    /* fall through */
  }
  return { width: 1024, height: 768 };
}

function anchorRectOf(anchor: unknown): TooltipAnchorRect | null {
  try {
    const el = anchor as { getBoundingClientRect?: () => TooltipAnchorRect };
    if (typeof el.getBoundingClientRect === 'function') {
      const r = el.getBoundingClientRect();
      if (r && Number.isFinite(r.top) && Number.isFinite(r.left)) return r;
    }
  } catch {
    /* unmeasurable anchor: caller falls back gracefully */
  }
  return null;
}

function measureNode(node: LooseNode, text: string): TooltipSize {
  try {
    const w = node['offsetWidth'];
    const h = node['offsetHeight'];
    if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) {
      return { width: w, height: h };
    }
  } catch {
    /* fall through to the estimate */
  }
  // Headless/fake-DOM estimate (only used for placement there): wrap at
  // ~48 chars per 320px line, ~16px per line plus padding.
  const lines = Math.max(1, Math.ceil(text.length / 48));
  return {
    width: Math.min(TOOLTIP_MAX_WIDTH, 48 + Math.min(text.length, 48) * 6),
    height: 16 + lines * 16,
  };
}

let tipNode: LooseNode | null = null;
let tipAnchor: LooseNode | null = null;
let tipVisible = false;

function findExistingNode(doc: LooseNode): LooseNode | null {
  try {
    const byId = doc['getElementById'];
    if (typeof byId === 'function') {
      const found = (byId as (id: string) => unknown).call(doc, TOOLTIP_ID);
      if (found && typeof found === 'object') return found as LooseNode;
    }
  } catch {
    /* no lookup API */
  }
  return null;
}

/**
 * Ensure the singleton tooltip node exists (created once, reused across
 * panel rebuilds and renderer switches). Appended to `document.body` when
 * available so sidebar scroll containers never clip it (`position: fixed`);
 * otherwise kept detached but fully functional for text/role/aria state.
 * Never throws; returns null headless.
 */
export function ensureTooltipNode(): LooseNode | null {
  if (tipNode) return tipNode;
  const doc = getDoc();
  if (!doc) return null;
  const existing = findExistingNode(doc);
  if (existing) {
    tipNode = existing;
    return tipNode;
  }
  let node: LooseNode | null = null;
  try {
    const created = doc['createElement'];
    if (typeof created !== 'function') return null;
    node = (created as (tag: string) => unknown).call(doc, 'div') as LooseNode;
  } catch {
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  try {
    node['id'] = TOOLTIP_ID;
    node.setAttribute?.('id', TOOLTIP_ID);
    node.setAttribute?.('role', 'tooltip');
    (node as Record<string, unknown>)['role'] = 'tooltip';
    // Never focusable: no focus trap, keyboard users stay on the anchor.
    try {
      node.removeAttribute?.('tabindex');
    } catch {
      /* absent is the goal */
    }
    const style = node['style'] as { cssText?: string } | undefined;
    if (style && typeof style === 'object') {
      try {
        style.cssText =
          `position:fixed;z-index:60;max-width:${TOOLTIP_MAX_WIDTH}px;` +
          'white-space:normal;overflow-wrap:anywhere;pointer-events:none;';
      } catch {
        /* style stub */
      }
    }
    hideNode(node);
  } catch {
    /* best-effort styling only */
  }
  try {
    const body = doc['body'] as { appendChild?: (c: unknown) => void } | undefined;
    if (body && typeof body.appendChild === 'function') body.appendChild(node);
  } catch {
    /* detached node still carries text/role/aria state */
  }
  tipNode = node;
  return tipNode;
}

function hideNode(node: LooseNode): void {
  try {
    node['hidden'] = true;
    node.setAttribute?.('hidden', '');
    const style = node['style'] as { display?: string } | undefined;
    if (style && typeof style === 'object') {
      try {
        style.display = 'none';
      } catch {
        /* style stub */
      }
    }
  } catch {
    /* best-effort */
  }
}

function showNode(node: LooseNode): void {
  try {
    node['hidden'] = false;
    node.removeAttribute?.('hidden');
    const style = node['style'] as { display?: string } | undefined;
    if (style && typeof style === 'object') {
      try {
        style.display = '';
      } catch {
        /* style stub */
      }
    }
  } catch {
    /* best-effort */
  }
}

function setDescribedBy(anchor: LooseNode | null, on: boolean): void {
  if (!anchor) return;
  try {
    if (on) anchor.setAttribute?.('aria-describedby', TOOLTIP_ID);
    else if (anchor.getAttribute?.('aria-describedby') === TOOLTIP_ID) {
      anchor.removeAttribute?.('aria-describedby');
    }
  } catch {
    /* non-critical affordance */
  }
}

/**
 * Show the tooltip for an anchor element (text override wins, otherwise the
 * anchor's `data-q2-tip`). Positions near the anchor within the viewport,
 * clamps the width on narrow viewports, links `aria-describedby`. No-op
 * headless or for empty text. Never throws.
 */
export function showPanelTooltip(anchor: unknown, text?: string): boolean {
  try {
    if (!anchor || typeof anchor !== 'object') return false;
    const msg = typeof text === 'string' && text.length > 0
      ? text
      : getTooltipText(anchor);
    if (!msg) return false;
    const node = ensureTooltipNode();
    if (!node) return false;
    if (tipAnchor && tipAnchor !== (anchor as LooseNode)) setDescribedBy(tipAnchor, false);
    tipAnchor = anchor as LooseNode;
    try {
      node['textContent'] = msg;
    } catch {
      /* text stub */
    }
    const viewport = readViewport();
    try {
      const style = node['style'] as { maxWidth?: string } | undefined;
      if (style && typeof style === 'object') {
        style.maxWidth = `${tooltipMaxWidthFor(viewport.width)}px`;
      }
    } catch {
      /* style stub */
    }
    const rect = anchorRectOf(anchor);
    const size = measureNode(node, msg);
    if (rect) {
      const at = computeTooltipPosition(rect, size, viewport);
      try {
        const style = node['style'] as
          | { top?: string; left?: string }
          | undefined;
        if (style && typeof style === 'object') {
          style.top = `${at.top}px`;
          style.left = `${at.left}px`;
        }
        (node as Record<string, unknown>)['__q2tipTop'] = at.top;
        (node as Record<string, unknown>)['__q2tipLeft'] = at.left;
      } catch {
        /* position stub */
      }
    }
    showNode(node);
    setDescribedBy(tipAnchor, true);
    tipVisible = true;
    return true;
  } catch {
    return false;
  }
}

/** Dismiss the tooltip and unlink `aria-describedby`. Never throws. */
export function hidePanelTooltip(): void {
  try {
    setDescribedBy(tipAnchor, false);
    tipAnchor = null;
    tipVisible = false;
    if (tipNode) hideNode(tipNode);
  } catch {
    /* best-effort */
  }
}

/** True while the tooltip is shown. */
export function isPanelTooltipVisible(): boolean {
  return tipVisible;
}

/** Current tooltip text (empty when hidden or headless). */
export function panelTooltipText(): string {
  try {
    if (!tipVisible || !tipNode) return '';
    const v = tipNode['textContent'];
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

// --- wiring ---------------------------------------------------------------

function asLoose(el: unknown): LooseNode | null {
  return el && typeof el === 'object' ? (el as LooseNode) : null;
}

/** Collect converted elements under a root (real or fake DOM). */
function collectTipped(root: unknown): LooseNode[] {
  const out: LooseNode[] = [];
  const loose = asLoose(root);
  if (!loose) return out;
  try {
    const qsa = loose['querySelectorAll'];
    if (typeof qsa === 'function') {
      const found = (qsa as (sel: string) => unknown).call(loose, `[${TOOLTIP_TEXT_ATTR}]`);
      if (found && typeof found === 'object') {
        const list = found as {
          length?: unknown;
          item?: (i: number) => unknown;
          [Symbol.iterator]?: () => Iterator<unknown>;
        };
        if (typeof list.length === 'number') {
          for (let i = 0; i < list.length; i++) {
            const n = asLoose(list.item?.(i));
            if (n) out.push(n);
          }
          return out;
        }
        if (typeof list[Symbol.iterator] === 'function') {
          for (const el of list as unknown as Iterable<unknown>) {
            const n = asLoose(el);
            if (n) out.push(n);
          }
          return out;
        }
      }
    }
  } catch {
    /* fall through to manual traversal */
  }
  // Fake-DOM path: recurse through `children`.
  try {
    const stack: unknown[] = [root];
    while (stack.length > 0) {
      const cur = stack.pop();
      const node = asLoose(cur);
      if (!node) continue;
      if (getTooltipText(node)) out.push(node);
      const kids = node['children'];
      if (Array.isArray(kids)) {
        for (const k of kids) stack.push(k);
      }
    }
  } catch {
    /* best-effort */
  }
  return out;
}

function onHide(): void {
  hidePanelTooltip();
}

function onDocKey(e: unknown): void {
  try {
    const key = (e as { key?: unknown })?.key;
    if (key === 'Escape' || key === 'Esc') hidePanelTooltip();
  } catch {
    /* never break panel input */
  }
}

function bindAnchor(el: LooseNode): void {
  try {
    const mark = el as Record<string, unknown>;
    if (mark['__q2tipBound'] === true) return;
    mark['__q2tipBound'] = true;
    const add = el.addEventListener;
    if (typeof add !== 'function') return;
    const show = (): void => {
      showPanelTooltip(el);
    };
    // Mouse hover (mouseover/out bubble in real DOM; mouseenter/leave are
    // direct — bind both, hide wins on leave either way).
    add.call(el, 'mouseover', show);
    add.call(el, 'mouseenter', show);
    add.call(el, 'mouseout', onHide);
    add.call(el, 'mouseleave', onHide);
    // Keyboard focus on labels/wrappers (incl. disabled-control wrappers).
    add.call(el, 'focus', show);
    add.call(el, 'focusin', show);
    add.call(el, 'blur', onHide);
    add.call(el, 'focusout', onHide);
  } catch {
    /* a single unbindable node must not break the panel */
  }
}

function wireDocLevel(doc: LooseNode): void {
  try {
    const mark = doc as Record<string, unknown>;
    if (mark['__q2tipDocWired'] === true) return;
    mark['__q2tipDocWired'] = true;
    const add = doc.addEventListener;
    if (typeof add !== 'function') return;
    // Dismiss on any scroll (capture: sidebar scrollers don't bubble),
    // on Escape, and on resize/zoom reflow — all best-effort, never fatal.
    try {
      (add as (t: string, fn: (e?: unknown) => void, opts?: unknown) => void).call(
        doc, 'scroll', onHide, true,
      );
    } catch {
      add.call(doc, 'scroll', onHide);
    }
    add.call(doc, 'keydown', onDocKey);
  } catch {
    /* headless stub */
  }
  try {
    const w = globalThis as unknown as {
      addEventListener?: (t: string, fn: () => void) => void;
      __q2tipWinWired?: boolean;
    };
    if (w && typeof w.addEventListener === 'function' && !w.__q2tipWinWired) {
      w.__q2tipWinWired = true;
      w.addEventListener('resize', onHide);
    }
  } catch {
    /* no window */
  }
}

/**
 * Attach hover/focus tooltip triggers under a panel root. Idempotent per
 * element and per document (re-renders and renderer switches never
 * accumulate listeners). Returns a detach that unbinds nothing structural
 * (nodes are dropped with the rebuild) but dismisses any shown tooltip.
 * Never throws.
 */
export function attachPanelTooltips(root: unknown): () => void {
  try {
    const doc = getDoc();
    if (doc) wireDocLevel(doc);
    for (const el of collectTipped(root)) bindAnchor(el);
  } catch {
    /* headless: no triggers to bind */
  }
  return () => {
    hidePanelTooltip();
  };
}

/** Test hook: forget the cached node/anchor (isolates fake-DOM suites). */
export function resetPanelTooltipForTests(): void {
  try {
    setDescribedBy(tipAnchor, false);
  } catch {
    /* best-effort */
  }
  tipNode = null;
  tipAnchor = null;
  tipVisible = false;
}

