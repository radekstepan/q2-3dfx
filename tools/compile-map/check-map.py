#!/usr/bin/env python3
"""tools/compile-map/check-map.py — static validation for Q2 .map source.

Catches the mistakes a compiler would report (or silently miscompile) without
needing a qbsp binary: brace balance, face syntax, degenerate planes, and
inward-facing planes (normal must be normalize(cross(p3-p1, p2-p1)) pointing
OUTWARD; the brush point-centroid must lie on the negative side of every
plane). Also checks the entity checklist (worldspawn, player start, lights).

Usage: check-map.py <file.map> [--strict]
Exit 0 when clean; exit 1 with diagnostics otherwise.
"""
import math
import re
import sys

FACE_RE = re.compile(
    r"\(\s*([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s*\)"
    r"\s*\(\s*([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s*\)"
    r"\s*\(\s*([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s*\)"
    r"\s*(\S+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)"
)

EPS = 1e-6


def strip_comments(text):
    return re.sub(r"//[^\n]*", "", text)


def tokenize_entities(text):
    """Split top-level { ... } blocks, respecting quoted strings."""
    blocks = []
    depth = 0
    start = None
    in_str = False
    esc = False
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start is not None:
                blocks.append(text[start : i + 1])
                start = None
            if depth < 0:
                return None  # unbalanced
    if depth != 0 or in_str:
        return None
    return blocks


def parse_block(block):
    """Return (pairs, brushes) where brushes are lists of raw face lines."""
    pairs = {}
    for m in re.finditer(r'"([^"]*)"\s+"([^"]*)"', block):
        pairs[m.group(1)] = m.group(2)
    brushes = []
    depth = 0
    cur = None
    in_str = False
    line_start = 0
    for i, ch in enumerate(block):
        if ch == "\n":
            line_start = i + 1
        if in_str:
            if ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
            if depth == 2:
                cur = []
        elif ch == "}":
            if depth == 2 and cur is not None:
                brushes.append((cur, line_start))
                cur = None
            depth -= 1
    # Fallback: gather face-looking lines per nested brace region.
    return pairs, brushes


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def check(path, strict):
    errors = []
    warnings = []
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    text = strip_comments(raw)
    blocks = tokenize_entities(text)
    if blocks is None:
        return ["unbalanced braces or unterminated string"], [], {"entities": 0, "brushes": 0}

    classnames = []
    n_brushes = 0
    for bi, block in enumerate(blocks):
        pairs, _ = parse_block(block)
        classname = pairs.get("classname", "(missing)")
        classnames.append(classname)
        if classname == "(missing)":
            errors.append(f"entity {bi}: missing classname")

    # Brush-aware pass: re-scan for { ... } regions nested inside entities.
    brush_id = 0
    for bi, block in enumerate(blocks):
        # Locate nested regions (depth >= 1 relative to entity open).
        regions = []
        depth = 0
        start = None
        in_str = False
        esc = False
        for i, ch in enumerate(block):
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
                if depth == 2:
                    start = i
            elif ch == "}":
                if depth == 2 and start is not None:
                    regions.append(block[start : i + 1])
                depth -= 1
        for region in regions:
            brush_id += 1
            faces = []
            for line in region.split("\n"):
                code = re.sub(r'"[^"]*"', "", line)
                if "(" not in code or ")" not in code:
                    continue
                m = FACE_RE.search(line)
                if not m:
                    if code.strip().startswith("("):
                        errors.append(
                            f"brush {brush_id}: malformed face line: {line.strip()[:100]}"
                        )
                    continue
                pts = [
                    (float(m.group(1)), float(m.group(2)), float(m.group(3))),
                    (float(m.group(4)), float(m.group(5)), float(m.group(6))),
                    (float(m.group(7)), float(m.group(8)), float(m.group(9))),
                ]
                n = cross(sub(pts[2], pts[0]), sub(pts[1], pts[0]))
                leng = math.sqrt(sum(c * c for c in n))
                if leng < EPS:
                    errors.append(f"brush {brush_id}: degenerate plane")
                    continue
                n = (n[0] / leng, n[1] / leng, n[2] / leng)
                faces.append((pts, n))
            if len(faces) < 4:
                errors.append(f"brush {brush_id}: only {len(faces)} faces (need >= 4)")
                continue
            cx = sum(p[0] for f, _ in faces for p in f) / (len(faces) * 3)
            cy = sum(p[1] for f, _ in faces for p in f) / (len(faces) * 3)
            cz = sum(p[2] for f, _ in faces for p in f) / (len(faces) * 3)
            for pts, n in faces:
                d = n[0] * pts[0][0] + n[1] * pts[0][1] + n[2] * pts[0][2]
                side = n[0] * cx + n[1] * cy + n[2] * cz - d
                if side > 1e-4:
                    errors.append(
                        f"brush {brush_id}: inward-facing plane "
                        f"(centroid on positive side by {side:.3f}); "
                        f"points must wind so cross(p3-p1,p2-p1) faces outward"
                    )
                    break
            n_brushes += 1

    if "worldspawn" not in classnames:
        errors.append("missing worldspawn entity")
    if "info_player_start" not in classnames:
        errors.append("missing info_player_start entity")
    if not any(c == "light" for c in classnames):
        warnings.append("no light entities (map will be fullbright)")

    if strict and warnings:
        errors.extend(f"strict: {w}" for w in warnings)
        warnings = []
    return errors, warnings, {"entities": len(blocks), "brushes": n_brushes}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    strict = "--strict" in sys.argv[1:]
    if not args:
        print("usage: check-map.py <file.map> [--strict]", file=sys.stderr)
        return 2
    errors, warnings, info = check(args[0], strict)
    print(f"{args[0]}: {info['entities']} entities, {info['brushes']} brushes")
    for w in warnings:
        print(f"warning: {w}")
    for e in errors:
        print(f"error: {e}")
    if errors:
        print(f"check-map: FAILED ({len(errors)} errors)")
        return 1
    print("check-map: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
