---
'@q2/server': patch
---

End-elevator finish screen with HelpComputer-lite stats. The server now owns
the finished state (BRAIN.md §15 single-sim): C `level.*` counters (totals
fixed at spawn; kills via the `SV_DamageMonster` funnel, secrets/goals via
single-use `target_secret`/`target_goal` handling with the C
`misc/secret.wav` noise), `SV_FinishLevel`/`SV_ClearFinished`, and a finish
trigger on `target_changelevel` use (real C exit) plus the two reachable
end-complex buttons — the one-way (`wait -1`) lift-call button firing a
train (base1 `*13`/t91, which also finds its secret) and the plug-platform
button firing `t4` (base1 `*34`, pressable only from the DOWN plug top).
The web driver mirrors the snapshot into its message/HUD only (frozen once
finished; the sim keeps running so the lift still rides): a centered blue
`FINISH_BLUE` stats block (`LEVEL COMPLETE` + `kills K/T  secrets S/T
goals G/T` + `time M:SS`) with a `finished` event/chime distinct from `exit`.

Play-verified: base1-gate (w) replays the user repro (plug top near
-1823,1540,112, lean into *34) and pins the message, counter sanity
(kills/secrets/goals <= totals), persistence across firing, and blue
pixels; headless server tests pin the t37 pit exit and the t91 button path
(including secret single-use and snapshot freeze).
