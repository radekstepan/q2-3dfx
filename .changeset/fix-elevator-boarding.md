---
'@q2/server': patch
---

Rideable elevator: pusher-carry, standing ground-link and button use in the driver loop.

Server (`@q2/server`): movers/plats/brush-trains are now solid in
`SV_ClipTrace` (displaced brush boxes, clip owns the hit so pmove's
`groundEntity` links riders to the pusher they stand on), `func_plat`
records brush bounds like doors, new `buttons.ts` C-parity helpers
(`button_touch`/`button_use`/`button_fire` gates incl. wait/-1) with
`SV_TouchButtonsAt` (contact press, 1u slop over the 1/32 rest) and
`SV_UseButton` (reach + facing cone + wall check, only the aimed button
fires), and `SV_CarryRiders` only carries feet-on-top riders (pre-move top
check, so the exit-hall camper no longer rides the opening *32 slab).
The web driver (`apps/web/src/play.ts` boarding/use/ride wiring only)
applies `SV_CarryRiders` after `SV_Tick` (exact, no one-tick lag), touches
buttons every tick, and presses the aimed button on `use` (E key /
right-mouse).

Play-verified in the driver loop (base1-gate (u)/(v), 22/22 green):
boarding the parked lift rests feet-on-top and grounded, the full t91 ride
carries without falling with the render tracking the sim bit-exactly, and
*13/*34 press by reach+facing with no targetname fan-out.
