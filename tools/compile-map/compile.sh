#!/usr/bin/env bash
# tools/compile-map/compile.sh — reproducible Quake II .map -> .bsp pipeline.
#
# Stages: geometry (qbsp) -> visibility (qvis) -> lighting (qrad/light).
# Fails loudly on any tool error or reported leak; records provenance.
#
# Usage:
#   compile.sh [--probe-only] [--check-only] [--dry-run] [--map <file>] [--outdir <dir>]
#              [--skip-check] [--skip-vis] [--skip-light] [--log <file>]
#
# Env overrides (full paths or names on PATH):
#   QBSP_BIN QVIS_BIN QLIGHT_BIN BSPINFO_BIN   tool binaries
#   QBSP_FLAGS QVIS_FLAGS QLIGHT_FLAGS         extra flags per stage
#
# Tool names differ per toolchain (id qbsp3/qvis3/qrad3 vs community forks),
# so each stage probes a candidate list and uses the first hit. ericw-tools
# is deliberately NOT probed: it targets Quake 1 / Hexen 2, not Q2 BSP38
# (see README.md). If no binary is found the script reports exactly what
# was looked for and where, instead of guessing.
#
# Exit status: 0 only when every executed stage passes with no leak.

set -u

MAP=""
OUTDIR=""
DRY_RUN=0
PROBE_ONLY=0
CHECK_ONLY=0
SKIP_CHECK=0
SKIP_VIS=0
SKIP_LIGHT=0
LOG=""

QBSP_CANDIDATES="${QBSP_BIN:-} qbsp3 qbsp q2bsp q2map"
QVIS_CANDIDATES="${QVIS_BIN:-} qvis3 qvis"
QLIGHT_CANDIDATES="${QLIGHT_BIN:-} qrad3 qrad light arghrad"
INFO_CANDIDATES="${BSPINFO_BIN:-} bspinfo bsputil"

usage() {
  sed -n '2,20p' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --probe-only) PROBE_ONLY=1; shift ;;
    --check-only) CHECK_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --map) MAP="${2:-}"; shift 2 ;;
    --outdir) OUTDIR="${2:-}"; shift 2 ;;
    --skip-check) SKIP_CHECK=1; shift ;;
    --skip-vis) SKIP_VIS=1; shift ;;
    --skip-light) SKIP_LIGHT=1; shift ;;
    --log) LOG="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "compile.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

find_tool() {
  # $1 = space-separated candidates. Prints the first resolvable binary.
  for cand in $1; do
    [ -n "$cand" ] || continue
    case "$cand" in
      */*) [ -x "$cand" ] && { echo "$cand"; return 0; } ;;
      *) command -v "$cand" >/dev/null 2>&1 && { command -v "$cand"; return 0; } ;;
    esac
  done
  return 1
}

tool_version() {
  # $1 = binary. Best-effort single-line version; never fails.
  local out=""
  out="$("$1" --version 2>&1 | head -n 1)" || out=""
  if [ -z "$out" ]; then
    out="$("$1" -version 2>&1 | head -n 1)" || out=""
  fi
  if [ -z "$out" ]; then
    out="$("$1" -h 2>&1 | head -n 1)" || out=""
  fi
  echo "$out" | tr -d '\r' | head -c 160
  return 0
}

probe_report() {
  echo "tool probe ($(date -u +%Y-%m-%dT%H:%M:%SZ), PATH=$PATH):"
  for stage in "qbsp:$QBSP_CANDIDATES" "qvis:$QVIS_CANDIDATES" "qlight:$QLIGHT_CANDIDATES" "info:$INFO_CANDIDATES"; do
    name="${stage%%:*}"
    cands="${stage#*:}"
    if bin="$(find_tool "$cands")"; then
      echo "  $name: FOUND $bin -- $(tool_version "$bin")"
    else
      echo "  $name: MISSING (tried:$cands)"
    fi
  done
  for ed in trenchbroom TrenchBroom; do
    if command -v "$ed" >/dev/null 2>&1; then
      echo "  editor: FOUND $(command -v "$ed")"
    fi
  done
}

if [ "$PROBE_ONLY" -eq 1 ]; then
  probe_report
  exit 0
fi

if [ -z "$MAP" ]; then
  echo "compile.sh: --map <file.map> is required" >&2
  exit 2
fi
if [ ! -r "$MAP" ]; then
  echo "compile.sh: map not readable: $MAP" >&2
  exit 2
fi
case "$MAP" in
  *.map) ;;
  *) echo "compile.sh: expected a .map file: $MAP" >&2; exit 2 ;;
esac

MAP_ABS="$(cd "$(dirname "$MAP")" && pwd)/$(basename "$MAP")"
STEM="$(basename "$MAP" .map)"
if [ -z "$OUTDIR" ]; then
  OUTDIR="$(dirname "$MAP_ABS")/build"
fi
mkdir -p "$OUTDIR"
if [ -z "$LOG" ]; then
  LOG="$OUTDIR/compile.log"
fi

# Static source check (no compiler needed): brace balance, face syntax,
# outward-facing planes, required entities. Runs before any tool stage.
CHECKER="$(cd "$(dirname "$0")" && pwd)/check-map.py"
if [ "$SKIP_CHECK" -eq 0 ] && [ -f "$CHECKER" ]; then
  if command -v python3 >/dev/null 2>&1; then
    echo "== stage: check-map =="
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "+ python3 $CHECKER $MAP_ABS --strict"
    elif python3 "$CHECKER" "$MAP_ABS" --strict; then
      echo "stage check-map: OK"
    else
      echo "stage check-map FAILED; fix the .map source first." >&2
      exit 8
    fi
  else
    echo "check-map: python3 not found, skipping static check (pass --skip-check to silence)" >&2
  fi
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "compile.sh: check-only done"
  exit 0
fi

# Dry run prints the exact commands a real run would use; tool binaries are
# shown by candidate name and are not required to exist.
if [ "$DRY_RUN" -eq 1 ]; then
  QBSP_DRY="${QBSP_BIN:-$(echo "$QBSP_CANDIDATES" | awk '{print $1}')}"
  QVIS_DRY="${QVIS_BIN:-$(echo "$QVIS_CANDIDATES" | awk '{print $1}')}"
  QLIGHT_DRY="${QLIGHT_BIN:-$(echo "$QLIGHT_CANDIDATES" | awk '{print $1}')}"
  probe_report
  echo "---"
  echo "== stage: qbsp =="
  echo "+ $QBSP_DRY ${QBSP_FLAGS:-} $OUTDIR/$STEM.map"
  if [ "$SKIP_VIS" -eq 0 ]; then
    echo "== stage: qvis =="
    echo "+ $QVIS_DRY ${QVIS_FLAGS:-} $OUTDIR/$STEM.bsp"
  fi
  if [ "$SKIP_LIGHT" -eq 0 ]; then
    echo "== stage: light =="
    echo "+ $QLIGHT_DRY ${QLIGHT_FLAGS:-} $OUTDIR/$STEM.bsp"
  fi
  exit 0
fi

QBSP="$(find_tool "$QBSP_CANDIDATES" || true)"
if [ -z "$QBSP" ]; then
  echo "compile.sh: no qbsp binary found (tried:$QBSP_CANDIDATES)" >&2
  echo "compile.sh: see tools/compile-map/README.md for toolchain setup." >&2
  probe_report >&2
  exit 3
fi
QVIS=""
QLIGHT=""
if [ "$SKIP_VIS" -eq 0 ]; then
  QVIS="$(find_tool "$QVIS_CANDIDATES" || true)"
  if [ -z "$QVIS" ]; then
    echo "compile.sh: no qvis binary found (tried:$QVIS_CANDIDATES); pass --skip-vis for an unvis'd test build." >&2
    exit 3
  fi
fi
if [ "$SKIP_LIGHT" -eq 0 ]; then
  QLIGHT="$(find_tool "$QLIGHT_CANDIDATES" || true)"
  if [ -z "$QLIGHT" ]; then
    echo "compile.sh: no lighting binary found (tried:$QLIGHT_CANDIDATES); pass --skip-light for a fullbright test build." >&2
    exit 3
  fi
fi

echo "== q2ts map compile: $STEM =="
echo "map:     $MAP_ABS"
echo "outdir:  $OUTDIR"
echo "log:     $LOG"
probe_report
echo "---"

# Stage list is fixed so --dry-run prints the exact commands a real run uses.
run_stage() {
  # $1 = stage name, $2... = command. Logs everything, fails loudly.
  local stage="$1"; shift
  echo "== stage: $stage =="
  echo "+ $*"
  if [ "$DRY_RUN" -eq 1 ]; then
    return 0
  fi
  echo "--- $stage: $* ---" >> "$LOG"
  if "$@" >> "$LOG" 2>&1; then
    echo "stage $stage: tool exit 0"
  else
    local code=$?
    echo "stage $stage FAILED (exit $code); tail of $LOG:" >&2
    tail -n 40 "$LOG" >&2
    return "$code"
  fi
}

WORK_BSP="$OUTDIR/$STEM.bsp"
# qbsp traditionally compiles next to the .map; copy the source into the
# outdir so intermediates (.pts/.lin/.bsp) land there, never in the repo.
cp "$MAP_ABS" "$OUTDIR/$STEM.map"

if [ "$DRY_RUN" -eq 0 ]; then
  : > "$LOG"
fi

# shellcheck disable=SC2086
run_stage "qbsp" "$QBSP" ${QBSP_FLAGS:-} "$OUTDIR/$STEM.map" || exit 4
if [ "$DRY_RUN" -eq 0 ] && [ ! -f "$WORK_BSP" ]; then
  # Some toolchains write next to the CWD or keep the input name: report.
  echo "stage qbsp: expected output missing: $WORK_BSP" >&2
  ls -la "$OUTDIR" >&2
  exit 4
fi

if [ -n "$QVIS" ]; then
  # shellcheck disable=SC2086
  run_stage "qvis" "$QVIS" ${QVIS_FLAGS:-} "$WORK_BSP" || exit 5
fi
if [ -n "$QLIGHT" ]; then
  # shellcheck disable=SC2086
  run_stage "light" "$QLIGHT" ${QLIGHT_FLAGS:-} "$WORK_BSP" || exit 6
fi

# Surface leaks/errors even when a tool exits 0 (some forks warn and continue).
if [ "$DRY_RUN" -eq 0 ]; then
  if grep -aiE "leak(ed|age)?|pointfile|\.lin\b" "$LOG" | grep -aviE "no leak|0 leaks" | head -n 20 >&2; then
    echo "LEAK/ERROR markers found above (from $LOG); inspect $OUTDIR/$STEM.pts|$STEM.lin" >&2
    LEAKED=1
  else
    LEAKED=0
  fi
  if [ -f "$OUTDIR/$STEM.pts" ] || [ -f "$OUTDIR/$STEM.lin" ]; then
    echo "leak pointfiles present in $OUTDIR (load in TrenchBroom to trace)" >&2
    LEAKED=1
  fi

  {
    echo "provenance: $STEM"
    echo "date_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "map_sha256: $(sha256sum "$MAP_ABS" | cut -d' ' -f1)"
    echo "qbsp: $QBSP -- $(tool_version "$QBSP")"
    echo "qvis: ${QVIS:-skipped} $([ -n "$QVIS" ] && echo -- "$(tool_version "$QVIS")")"
    echo "qlight: ${QLIGHT:-skipped} $([ -n "$QLIGHT" ] && echo -- "$(tool_version "$QLIGHT")")"
    echo "flags: QBSP_FLAGS='${QBSP_FLAGS:-}' QVIS_FLAGS='${QVIS_FLAGS:-}' QLIGHT_FLAGS='${QLIGHT_FLAGS:-}'"
  } > "$OUTDIR/provenance.txt"

  if INFO="$(find_tool "$INFO_CANDIDATES" || true)"; [ -n "$INFO" ] && [ -f "$WORK_BSP" ]; then
    echo "== bspinfo =="
    "$INFO" "$WORK_BSP" 2>&1 | head -n 40 || true
  fi

  if [ "$LEAKED" -ne 0 ]; then
    echo "compile.sh: FAILED (leak markers; see $LOG)" >&2
    exit 7
  fi
  echo "compile.sh: OK -> $WORK_BSP"
fi
