---
"@q2/host": minor
---

Add optional server-authoritative `HostDriver` (`spawn`/`step`/`snapshot`): when attached, server ticks delegate to the driver, snapshots sync the local origin, and offline placeholder prediction is skipped. Renderables now exclude the local player (it sits at the camera). Default driverless behavior is unchanged.
