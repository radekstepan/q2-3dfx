---
'@q2/host': patch
---

RELEASE-7 (host lane): add rapid bidirectional resize regression pinning refresh-plane sync (refresh.fb === host.fb at the new stride after every resize, old planes detached, sim untouched, 1:1 initCount). No production change — Host.resize audit confirmed correct.
