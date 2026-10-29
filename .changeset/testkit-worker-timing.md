---
'@q2/testkit': patch
---

Add PERF-NEXT-4 worker-timing integration and reporting: real-built-Node-worker execution tests (real worker_threads worker running the real built scanout band kernel with in-worker measured execMs plus frame/seq/job/band identity and hash-verified work, and a real BandWorkerPool pooled kick with finite dispatch fence plus feature-detected exec stats), browser-entry protocol coverage without DOM (completion-message parser plus DiagSnapshot structural read), max-vs-median straggler analysis with straggler identity, a Q2_DETAIL_TIMING kill-switch (acceptance runs disabled), and feature-detected band-exec/material-GC hook readers. Consumer-only: no renderer or contract changes.
