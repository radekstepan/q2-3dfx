---
'@q2/sw-renderer': minor
---

Retained-frame RGB foreground recovery (complete-frame replay with suffix-selective clear, quarantine on timeout, commitRGB at frame end) and exact worker model/gun rasterization (serial alias filler over staged screen tris, sprites/particles/tracers as spans, one ordered kick). Truthful per-class foreground counters (staged/worker-completed/calling-thread/inline/fallback/replayed). All pooled paths remain bit-identical to serial; failures converge with exactly-once blends.
