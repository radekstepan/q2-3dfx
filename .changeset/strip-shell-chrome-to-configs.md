---
'web': patch
---

Strip shell chrome above the config list

- Removes the page top strip (`#q2-topbar`) and the sidebar faceplate header (`#q2-ui-head` with the `Game config` title + mode box), plus their CSS, so the sidebar starts directly at the numbered `01` group and the first set of configs.
- The game stage, console strip, config list, and footer buttons (`revert view`, `clear cached pak`) are unchanged; the boot/console/mode JS already null-guards the removed nodes, so no logic changes were needed.
