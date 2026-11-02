// q2ts-web landing overlay: qwasm2-style entry screen (demo / pak / devroom).
//
// Browser-only helpers, headless-safe (every touch is DOM-guarded so Node
// imports stay free). The markup lives in `index.html#q2-landing`; this
// module only shows/hides it and wires the buttons.
export interface LandingActions {
  onDemo: () => void;
  onPick: (file: File) => void;
  onDevroom: () => void;
  onCached: () => void;
  onMenu?: () => void;
}

function el(id: string): HTMLElement | null {
  try {
    if (typeof document === 'undefined') return null;
    return document.querySelector(`#${CSS.escape(id)}`);
  } catch {
    try {
      return document.querySelector(`#${id}`);
    } catch {
      return null;
    }
  }
}

function asButton(node: HTMLElement | null): HTMLButtonElement | null {
  return node as HTMLButtonElement | null;
}

function asInput(node: HTMLElement | null): HTMLInputElement | null {
  return node as HTMLInputElement | null;
}

/** True when the landing overlay exists and is not hidden. */
export function isLandingVisible(): boolean {
  const node = el('q2-landing');
  if (!node) return false;
  return !node.hasAttribute('hidden');
}

/** Show the landing overlay (kills pointer lock implicitly by overlaying). */
export function showLanding(): void {
  const node = el('q2-landing');
  if (!node) return;
  try {
    node.removeAttribute('hidden');
  } catch {
    /* non-DOM stub */
  }
}

/** Hide the landing overlay once a boot starts. */
export function hideLanding(): void {
  const node = el('q2-landing');
  if (!node) return;
  try {
    node.setAttribute('hidden', '');
  } catch {
    /* non-DOM stub */
  }
}

/** Status line inside the landing card; empty text clears it. */
export function setLandingStatus(text: string): void {
  const node = el('q2-landing-status');
  if (!node) return;
  try {
    node.textContent = text;
  } catch {
    /* non-DOM stub */
  }
}

/** Enable/disable all landing buttons during the demo download. */
export function setLandingBusy(busy: boolean): void {
  for (const id of ['q2-play-demo', 'q2-pick-pak', 'q2-play-devroom', 'q2-play-cached']) {
    const node = asButton(el(id));
    if (!node) continue;
    try {
      node.toggleAttribute('disabled', busy);
      (node as unknown as { disabled?: boolean }).disabled = busy;
    } catch {
      /* non-DOM stub */
    }
  }
}

/**
 * Reveal the cached-pak button when IndexedDB holds a pak (`null` hides it).
 * Pure label logic, headless-testable via `cachedButtonLabel`.
 */
export function cachedButtonLabel(name: string, entries: number): string {
  return `continue ${name} · ${entries} lumps`;
}

/** Show/hide the cached-pak continue button. */
export function setCachedAvailable(label: string | null): void {
  const node = asButton(el('q2-play-cached'));
  if (!node) return;
  try {
    if (label === null) {
      node.setAttribute('hidden', '');
    } else {
      node.removeAttribute('hidden');
      node.textContent = label;
    }
  } catch {
    /* non-DOM stub */
  }
}

/** Wire the landing buttons + hidden file input. No-op without DOM. */
export function attachLanding(actions: LandingActions): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const demo = asButton(el('q2-play-demo'));
  const pick = asButton(el('q2-pick-pak'));
  const file = asInput(el('q2-pak-file'));
  const devroom = asButton(el('q2-play-devroom'));
  const cached = asButton(el('q2-play-cached'));
  const cleanups: Array<() => void> = [];
  const on = (
    node: HTMLButtonElement | HTMLInputElement | null,
    type: string,
    fn: (e: Event) => void,
  ): void => {
    if (!node) return;
    node.addEventListener(type, fn as EventListener);
    cleanups.push(() => node.removeEventListener(type, fn as EventListener));
  };
  on(demo, 'click', () => actions.onDemo());
  on(devroom, 'click', () => actions.onDevroom());
  on(cached, 'click', () => actions.onCached());
  on(pick, 'click', () => {
    try {
      file?.click();
    } catch {
      /* picker unavailable */
    }
  });
  on(file, 'change', () => {
    const f = (file?.files?.[0] as File | undefined) ?? undefined;
    if (!f) return;
    try {
      actions.onPick(f);
    } finally {
      try {
        file!.value = '';
      } catch {
        /* keep selection */
      }
    }
  });
  return () => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        /* detach best-effort */
      }
    }
  };
}
