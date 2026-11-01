---
'@q2/server': patch
---

fix(server): honor the arrival corner's own wait on patrol transitions (RELEASE-13)

SV_TickMonsters resolved patrolAdvance(arrived) to the next corner, then applied the next corner's wait — C path_corner_touch uses self->wait, the corner just reached. New arrivePatrol() mirrors the C order exactly: fire the arrived corner's pathtarget, teleport-hop the next link (snap z +16, chain through), pre-install movetarget, then stand out the ARRIVED wait; empty/dangling links end the beat standing. No base1 monster-route corner carries wait/teleport/pathtarget, so live beats are behavior-identical — the fields exist for C fidelity.

Tests: unequal consecutive waits (2s then 5s, old code armed 5s at the first corner — fails pre-fix), zero-wait pass-through, terminal stand, teleport snap+chain, live pathtarget fire waking a dormant body (server suite 272/272); live-game beats for all nine base1 patrollers, rear/jump silence, melee-behind acquire, gunfire-behind hearing and frontal acquire (new apps/web patrol-beat.test.ts 3/3, base1 gate 24/24).
