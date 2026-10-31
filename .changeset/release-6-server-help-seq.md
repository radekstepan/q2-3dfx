---
'@q2/server': patch
---

RELEASE-6 server lane: add the game-side help-notification producer (C g_target.c Use_Target_Help). ServerState gains helpChangedSeq + helpMessage1/2, fireTargets latches messages and bumps the sequence per firing, message-less target_help edicts are freed at spawn, and two pure cadence helpers (helpIconVisible, helpBeepDue) encode the p_hud.c/p_view.c flash/beep rules for the web lane. Per-client ack stays driver-side; finish snapshots unchanged.
