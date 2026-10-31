// asset-cooker/check-deps — enforce the BRAIN.md §4 dependency diagram.
//
// Usage: node tools/asset-cooker/dist/check-deps.js [--root <dir>]
// Scans packages/*/src + apps/*/src + tools/*/src for `@q2/*` imports and
// fails on any edge the diagram does not sanction. Exit 0 prints a summary.
//
// Ground rules (BRAIN.md §4 + §5):
// - Nothing imports from apps/* (apps are leaves).
// - @q2/config is importable everywhere (Com_Error lives there, §5).
// - The per-package allowlist below is the §4 graph plus a minimal set of
//   DOCUMENTED reality exceptions (implementer-needs-interface,
//   harness-only, host wiring). Adding a new edge means updating ALLOW with
//   a comment, not sneaking an import past review.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface DepEdge {
  /** owning package id ('bsp'), 'app:web', or 'tool:bench' */
  from: string;
  /** imported package id ('formats') or 'app:web' */
  to: string;
  file: string;
}

/**
 * Package allowlist. Key = packages/<name>. '*' = any package (harness).
 * Deviations from the §4 text carry their justification inline; everything
 * else must match the diagram exactly.
 */
export const ALLOW: Record<string, string[]> = {
  config: [],
  math: [],
  filesystem: ['config'],
  // math is §4-sanctioned (math ← formats) though unused in src today.
  formats: ['config', 'math'],
  bsp: ['config', 'formats', 'math'],
  // renderer-api: implements Refresh (the interface package); the §4 line
  // reads as geometry-front-end reuse, and the implementer must see the
  // interface it implements.
  'sw-renderer': ['bsp', 'config', 'formats', 'math', 'renderer-api'],
  // RELEASE-8 (retired): the legacy CPU Voodoo execution mode is retired; the
  // Voodoo3 appearance policy is implemented by `webgl-renderer` (duplicated by
  // value in `appearance.ts`, no dep edge). This row is residual — the only
  // real edges left from the remaining sources are `config` (`vd_*` cvar
  // reads) and `sw-renderer` (test-only scanout band helper). No package may
  // (re)gain a `voodoo` edge; delete this row with the package.
  voodoo: ['config', 'sw-renderer'],
  // GPU-PROOF-2: WebGL2 boundary implementation. renderer-api (boundary
  // types it implements), sw-renderer (MiniWorld + camera helpers for scene
  // selection — KEEP this edge; RELEASE-8 reuses the CPU front end, it does
  // not fork it), bsp (asset loading in tests). RELEASE-8: this package owns
  // the Voodoo3 appearance policy (duplicated by value in `appearance.ts`;
  // `@q2/voodoo` is NOT an allowed edge). Browser graphics types
  // (WebGL2RenderingContext) may appear ONLY here and in apps/web.
  // formats: test-only real-asset parsing (parseMD2/WAL/PCX in Q2_PAK-gated
  // tests, mirroring the game package's asset-data justification).
  'webgl-renderer': ['bsp', 'config', 'formats', 'math', 'renderer-api', 'sw-renderer'],
  // math: Vec3 types (+config per §5, unused today).
  'renderer-api': ['config', 'math'],
  // formats: WAL/MD2 asset data (real use; §4 lists only math+bsp+config).
  game: ['bsp', 'config', 'formats', 'math'],
  // filesystem: map loading; math: sim vec math (real use; §4: game+bsp).
  server: ['bsp', 'config', 'filesystem', 'game', 'math'],
  // input/sound are diagram-sanctioned though unused in src today.
  client: ['config', 'game', 'input', 'renderer-api', 'sound'],
  // host wires the concrete backends (input/sound/renderer-api are real
  // use; §4 names only server+client).
  host: ['client', 'config', 'input', 'renderer-api', 'server', 'sound'],
  // Harness only, never shipped: may use anything except apps/*.
  testkit: ['*'],
  input: ['config'],
  // RELEASE-1: sound reads s_volume scale + Com_Error from config (leaf,
  // acyclic — config deps: none). Table was stale, not the code.
  sound: ['config'],
};

const APP_OWNERS = ['app:web', 'app:devtools'];
const TOOL_OWNERS = ['tool:asset-cooker', 'tool:bench'];

function ownerOf(rel: string): string | null {
  let m = /^packages\/([^/]+)\/src\//.exec(rel);
  if (m) return m[1]!;
  m = /^apps\/([^/]+)\/src\//.exec(rel);
  if (m) return `app:${m[1]!}`;
  m = /^tools\/([^/]+)\/src\//.exec(rel);
  if (m) return `tool:${m[1]!}`;
  return null;
}

/** Pure check: violation messages for edges outside the allowlist. */
export function checkGraph(edges: DepEdge[]): string[] {
  const out: string[] = [];
  for (const e of edges) {
    if (e.to.startsWith('app:')) {
      out.push(`${e.file}: ${e.from} imports ${e.to} (nothing may import from apps/*)`);
      continue;
    }
    if (e.from.startsWith('app:') || e.from.startsWith('tool:')) {
      // apps/tools may use any package (never apps/*, enforced above).
      // Leaf convenience, NOT a sanction: RELEASE-8 retires every
      // app:web/tool:bench → voodoo edge (resolve/scanout/RGB legs move to
      // the code lanes; the final tree has zero `voodoo`-target edges
      // outside testkit's harness `*`). Do not add new ones.
      if (e.to.startsWith('app:') || e.to.startsWith('tool:')) {
        out.push(`${e.file}: ${e.from} imports ${e.to} (apps/tools may only use packages/*)`);
      }
      continue;
    }
    if (e.from === e.to) {
      out.push(`${e.file}: ${e.from} imports itself (use relative imports)`);
      continue;
    }
    const allow = ALLOW[e.from];
    if (!allow) {
      out.push(`${e.file}: unknown owner ${e.from}`);
      continue;
    }
    if (allow.includes('*')) continue;
    if (!allow.includes(e.to)) {
      const known = [...Object.keys(ALLOW), ...APP_OWNERS, ...TOOL_OWNERS];
      if (!known.includes(e.to) && !e.to.startsWith('tool:')) {
        out.push(`${e.file}: ${e.from} imports unknown package ${e.to}`);
      } else {
        out.push(
          `${e.file}: ${e.from} imports ${e.to} (BRAIN.md §4 allows: ${allow.join(', ') || '(none)'})`,
        );
      }
    }
  }
  return out;
}

const IMPORT_RE = /(?:from\s+|require\(\s*|import\(\s*)['"]@q2\/([a-z0-9-]+)['"]/g;
const APP_IMPORT_RE = /(?:from\s+|require\(\s*|import\(\s*)['"]\.\.\/[^'"]*['"]/g;

/** Walk src trees and collect every @q2/* edge (plus relative escapes). */
export function collectEdges(root: string): DepEdge[] {
  const edges: DepEdge[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let st: { isDirectory(): boolean };
      try {
        st = statSync(full);
      } catch {
        // Dangling symlink or otherwise unreadable entry (e.g. gitignored
        // test-output browser profiles): skip it instead of aborting the
        // whole tree walk — an abort silently blinds the gate to every owner
        // walked after the failure (RELEASE-8: `voodoo`/`webgl-renderer`
        // went unscanned, hiding exactly the retirement edges).
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
      const rel = full.slice(root.length + 1).replace(/\\/g, '/');
      const owner = ownerOf(rel);
      if (!owner) continue;
      const text = readFileSync(full, 'utf8');
      IMPORT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = IMPORT_RE.exec(text)) !== null) {
        edges.push({ from: owner, to: m[1]!, file: rel });
      }
      // Relative imports that escape into another package/app (packages/*,
      // apps/*, tools/* are siblings): ../../bsp/src/... style reaches.
      APP_IMPORT_RE.lastIndex = 0;
      let r: RegExpExecArray | null;
      while ((r = APP_IMPORT_RE.exec(text)) !== null) {
        const target = r[0]!;
        const abs = resolve(dir, target.slice(target.indexOf("'") + 1, -1));
        const trel = abs.slice(root.length + 1).replace(/\\/g, '/');
        const towner = ownerOf(trel + '/src/x');
        if (towner && towner !== owner) {
          edges.push({ from: owner, to: towner, file: rel });
        }
      }
    }
  };
  for (const d of ['packages', 'apps', 'tools']) {
    try {
      walk(join(root, d));
    } catch {
      /* missing tree (sparse checkout): skip */
    }
  }
  return edges;
}

function main(): number {
  const args = process.argv.slice(2);
  let root = resolve(process.cwd());
  const ri = args.indexOf('--root');
  if (ri >= 0 && args[ri + 1]) root = resolve(args[ri + 1]!);
  const edges = collectEdges(root);
  const owners = new Set(edges.map((e) => e.from));
  const violations = checkGraph(edges);
  if (violations.length > 0) {
    for (const v of violations) console.error(`deps:check violation: ${v}`);
    console.error(`deps:check FAILED: ${violations.length} violation(s) in ${edges.length} edges`);
    return 1;
  }
  console.log(`deps:check ok: ${edges.length} edges across ${owners.size} owners, no violations`);
  return 0;
}

const isMain = process.argv[1] !== undefined &&
  (process.argv[1].endsWith('check-deps.js') || process.argv[1].endsWith('check-deps.mjs') || process.argv[1].endsWith('check-deps.ts'));
if (isMain) {
  process.exit(main());
}
