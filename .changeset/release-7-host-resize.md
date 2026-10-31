---
'@q2/host': patch
---

RELEASE-7 (host lane): preserve the game simulation across framebuffer resizes. Validate/reserve the selected display size up front, carry overlapping pixels into the new framebuffer, and add capture/restore/dispose coordination hooks so renderer switches and context loss no longer require a level reboot.
