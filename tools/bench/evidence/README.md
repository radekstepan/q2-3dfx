# Durable bench evidence (PERF-NEXT-1)

Ledger rows point here — **never** at `/tmp/opencode/*.log`.
`/tmp` is scratch; this directory is the record.

## Layout

```
tools/bench/evidence/
  README.md                      ← you are here
  .gitignore                     ← ignores raw/ (large per-rep blobs)
  node-compare-<commit>-<ts>.manifest.json    ← COMMITTED summaries
  node-rgbattr-<commit>-<ts>.manifest.json
  node-accept-<commit>-<ts>.manifest.json
  browser-soak-<commit>-<ts>.manifest.json
  raw/                           ← GITIGNORED full run JSON (per-rep samples)
    node-compare-<commit>-<ts>.json
    node-rgbattr-<commit>-<ts>.json
    node-accept-<commit>-<ts>.json
    browser-soak-<commit>-<ts>.json
```

- `*.manifest.json` are **committed**: provenance + summary + `ledgerHint`
  (small, reviewable). The perf ledger references these paths.
- `raw/` is **gitignored**: full run JSON with raw per-rep samples
  (`frameReps[]` on stationary rows, `frameMs[]` on moving rows).

## What every manifest records

- Reproducible command: `argv` + allowlisted env (`COMPARE_*`, `RGB_*`,
  `Q2_PAK` path, … — no secrets, never the whole environ).
- Git commit (short + full) + tree dirtiness.
- Build freshness (`distFreshness`: dist mtime vs newest engine-src mtime;
  a stale dist silently benchmarks old code — runners WARN, acceptance
  hard-fails).
- Pak identity: path + bytes + mtime (the pak itself is NEVER copied here).
- Machine (cpu/model, mem, os), node version, 1/5/15-min load + quiet verdict.
- Browser (name/version/headless) for soak records; Node runs record
  `browser: null` and must never be compared against browser FPS.
- Full fidelity cvar profile (`vd_*` + `sw_*` raw strings, snapped after the
  measured loops while `pinPerfCvars` is still armed). Note: `vd_*` is
  constant across configs; `sw_workers`/`sw_accum` are loop variables, so the
  snapshot shows the LAST config's armed values — the swept set is in
  `workers` and each raw row records its own `workers` count.
- Warmup / reps / workers.
- `resultFile`: absolute path of the raw run JSON.
- `summary`: 640×480 acceptance medians (320×240 is diagnostic-only and is
  excluded from summaries by design).
- `ledgerHint`: suggested perf-ledger row text.

## Capturing the 4631ca2 baseline (separate worktree, untouched checkout)

The baseline MUST NOT disturb the user's checkout. Recipe (run sequentially,
quiet machine, same env for every leg):

```bash
# 1. Separate worktree at the baseline commit (sibling of this checkout):
git worktree add /tmp/q2ts-baseline 4631ca2
cd /tmp/q2ts-baseline && corepack enable && yarn install && yarn build

# 2. Full controlled matrix from the BASELINE tree, raw + manifest land in
#    THIS checkout's evidence dir via absolute COMPARE_OUT (or copy them over
#    afterwards — either way the ledger references evidence/ paths):
cd /tmp/q2ts-baseline/tools/bench
Q2_PAK=$HOME/dev/q2/baseq2/pak0.pak \
COMPARE_OUT=/home/radek/dev/q2-3dfx/q2ts/tools/bench/evidence/raw/node-compare-4631ca2-baseline.json \
COMPARE_MANIFEST_OUT=/home/radek/dev/q2-3dfx/q2ts/tools/bench/evidence/node-compare-4631ca2-baseline.manifest.json \
yarn bench:compare-run

# 3. Rebuild this checkout, rerun the IDENTICAL command (same env), then diff:
cd /home/radek/dev/q2-3dfx/q2ts && yarn build
cd tools/bench
Q2_PAK=$HOME/dev/q2/baseq2/pak0.pak \
COMPARE_OUT=evidence/raw/node-compare-<head>-candidate.json \
COMPARE_MANIFEST_OUT=evidence/node-compare-<head>-candidate.manifest.json \
yarn bench:compare-run
COMPARE_BASE=../evidence/node-compare-... COMPARE_HEAD=... yarn bench:compare-diff
# A settings mismatch VOIDS the comparison (exit 1) — never infer commit
# gains from old unmatched ledger rows.

# 4. Tear down the worktree when done:
git worktree remove /tmp/q2ts-baseline
```

Each tree has its own `dist/` (the worktree is a full checkout), so build
outputs never collide. Default `COMPARE_OUT` already lands in
`evidence/raw/`; the absolute-path form above is only needed when writing
from the worktree into this checkout.

## Browser baseline (recorded separately from Node)

Node `frameMs` is production-frame-**no-present** by construction; browser
acceptance is **presented FPS** from a CDP/rAF soak. Different quantities,
different records — never diffed against each other.

To store a browser baseline, hand the importer a soak JSON:

```bash
BROWSER_SOAK_IN=./soak-640-voodoo-w7.json yarn bench:browser-soak
```

Soak schema (`BrowserSoakRecord`, validated — the importer exits 1 on
violation):

| field | requirement |
| --- | --- |
| `browser.{name,version,headless}` | exact build, e.g. Chromium 130.0.6723.91 |
| `compositor` | `swiftshader` \| `software` \| `hardware` — `unknown` is REJECTED |
| `compositorDetail` | e.g. the `GL_RENDERER` string, so the class is auditable |
| `hardwareBacked` | `true` only for real-GPU presentation; must agree with `compositor` |
| `resolution/width/height` | must agree with each other (640×480 for acceptance) |
| `renderer`, `workers`, `workloads` | voodoo/software, worker sweep, intervals covered |
| `durationS ≥ 300`, `samples` | soak length (≥5 min) + presented-frame count |
| `presentedFpsMedian`, `frameP50Ms/P95Ms/MaxMs` | percentiles (numbers or null) |
| `fidelity`, `warmupS`, `pak`, `machineDetail` (optional) | FOLLOW-1 provenance: pinned vd_* + sw_* profile, warmup seconds, pak identity, host machine — absent stays null with a `limitations` entry, never a fabricated default |
| `sourceDirty`, `sourceDirtyFiles`, `chromiumFlags`, `cvarSnapshot` (optional) | source/build identity: run-time dirty flag + file list, GL flags, effective page cvars |
| `refreshHz`, `vsync`, `droppedFrames`, `cpuFallback` (optional) | gate fields: BeginFrames rate (NOT display refresh), vsync verification, presented drops, fallback void |
| `limitations` (optional) | explicit missing-provenance notes carried into the manifest |

Example: `evidence/browser-soak.example.json` (template — fill in measured
values, never commit fabricated numbers).

## FOLLOW-1 timing vocabulary + manifest history

- rAF/submission cadence = unthrottled BeginFrames rate (main-thread work
  headroom, NOT display refresh). CPU frame work = caller-clock
  drains/sim/view/tail/submit/total (submitMs is submission work, NOT GPU
  execution). Async GPU duration = unknown (no timer query). Displayed-frame
  evidence requires a visible (`headless=false`) vsync-locked leg.
- Pre-FOLLOW-1 GPU manifests (notably
  `browser-soak-8544883-2026-10-29T10-03-32`) record `fidelity` null,
  `warmup` null, `machine` {}, pak missing, on a dirty tree with no file
  list. They are PRESERVED with those limits (see
  `docs/gpu-follow-1-reconciliation.md`); the importer now records explicit
  `limitations` instead of silent gaps, and `gpu-soak.mjs` populates the
  full provenance on new runs.

## Settings-mismatch policy

`compare-diff` verifies warmup/reps/workers/yawStep + the full config list
and exits 1 on mismatch. Old ledger rows without a manifest are
uncontrolled history — cite them as context, never as commit gains.
