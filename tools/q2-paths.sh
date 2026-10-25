#!/usr/bin/env bash
# q2-paths.sh — resolve paths to the Quake II reference material that lives
# SIBLING to this repo in ../external/ (outside git, never committed).
#
# Usage (bash):
#   source tools/q2-paths.sh   # export Q2_SRC / Q2_PAK / Q2_DOCS (respects pre-set env)
#   ./tools/q2-paths.sh        # print the resolved values without exporting
#
# Env vars (all optional overrides; defaults are relative to this repo root,
# so no absolute user paths are hardcoded):
#   Q2_EXTERNAL_DIR  directory holding the reference material (default: <repo>/../external)
#   Q2_SRC           id Quake II source tree (default: $Q2_EXTERNAL_DIR/quake-2-source)
#   Q2_PAK           path to a pak0.pak FILE (default: $Q2_EXTERNAL_DIR/q2/baseq2/pak0.pak).
#                    Asset-dependent tests skip when Q2_PAK is absent/unreadable, e.g.:
#                      Q2_PAK=/path/to/pak0.pak yarn workspace @q2/testkit test
#   Q2_DOCS          Voodoo3 programming reference (default: $Q2_EXTERNAL_DIR/voodoo3_progguide.pdf)
# NOTE: no `set -u`/`set -e` here on purpose — this file is meant to be
# sourced, and changing the caller's shell options would be rude.

_Q2_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
: "${Q2_EXTERNAL_DIR:=$_Q2_ROOT/../external}"
: "${Q2_SRC:=$Q2_EXTERNAL_DIR/quake-2-source}"
: "${Q2_PAK:=$Q2_EXTERNAL_DIR/q2/baseq2/pak0.pak}"
: "${Q2_DOCS:=$Q2_EXTERNAL_DIR/voodoo3_progguide.pdf}"

_q2_warn() {
  # shellcheck disable=SC2059
  printf "q2-paths: WARNING: %s\n" "$1" >&2
}
[ -d "$Q2_SRC" ] || _q2_warn "Q2_SRC not found: $Q2_SRC"
[ -r "$Q2_PAK" ] || _q2_warn "Q2_PAK not readable (asset tests will skip): $Q2_PAK"
[ -r "$Q2_DOCS" ] || _q2_warn "Q2_DOCS not found: $Q2_DOCS"

if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  printf 'Q2_EXTERNAL_DIR=%s\nQ2_SRC=%s\nQ2_PAK=%s\nQ2_DOCS=%s\n' \
    "$Q2_EXTERNAL_DIR" "$Q2_SRC" "$Q2_PAK" "$Q2_DOCS"
else
  export Q2_EXTERNAL_DIR Q2_SRC Q2_PAK Q2_DOCS
fi
