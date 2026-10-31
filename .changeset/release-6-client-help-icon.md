---
'@q2/client': patch
---

RELEASE-6 client lane: add pure helpIconFor helper encoding G_SetStats STAT_HELPICON priority (flashing i_help iff helpChanged and (frame and 8), else weapon icon iff center-handed or fov > 91, else nothing) plus HelpIconArgs/HELP_ICON_PIC; pin HelpFacts/buildHelpLayout live-counter semantics (live level counters, kills %3i, goals/secrets %i) with tests. No executeStatusbar change.
