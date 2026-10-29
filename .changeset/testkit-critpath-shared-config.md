---
'@q2/testkit': patch
---

Add trustworthy critical-path helpers (critpath): caller-clock kick latencies with frame/seq/job/band identity, per-rep main-thread split with reconciling gap, staging/skip/cache/chain-byte collectors over public renderer hooks. Documents the timebase rule (no cross-clock subtraction; message arrival is not compute) and the per-worker-executor gap awaiting renderer in-worker timestamps. Flip the ESM/CJS config-store test from pinned isolation to shared (packages/config singleton). No gate changes.
