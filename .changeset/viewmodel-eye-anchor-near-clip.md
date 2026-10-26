---
"@q2/host": patch
"@q2/sw-renderer": patch
"@q2/renderer-api": minor
"@q2/game": patch
---

Hand-with-blaster + blaster + monster-facing batch (C-faithful): eye-anchored viewmodel + near-plane Sutherland clip + RF_DEPTHHACK. `Host.renderCurrentView` now places the `viewModel()` gun AT the eye (`VIEWMODEL_FORWARD = 0`, origin = viewOrigin) with the full view angles, citing `CL_AddViewWeapon` (client/cl_ents.c: gun origin = vieworg + gunoffset with gun_x/y/z default 0, angles = viewangles + gunangles), and hides it when fovX > 90 like id. The alias backend no longer drops whole tris touching the near plane: straddling tris are Sutherland-clipped in view space at vz = near (r_aclip.c `R_ClipPolyPlane` semantics, up to 4 verts re-projected with the same focal math, then 1-2 tris through `fillAffineTri` with per-tri backface cull). All-inside tris take a fast path that is bit-identical to the old projection (Float64 clip scratch — Float32 rounding audibly moved the devroom golden during development). New `Entity.depthHack` (optional, frozen-contract additive; BRAIN.md §6 needs the one-line addition) feeds `DEPTHHACK_SCALE = 3` (ref_soft `s_ziscale *= 3`) into `AliasInstance.depthScale`, biasing stored 1/z so the gun wins vs nearby walls — note this multiplies iz by 3, not 0.33 (larger iz = nearer under the `iz > zb` test). Devroom golden `8f61c755` preserved; measured eye-anchored fallback gun: 462px level / 2083px pitch -30 / 39px pitch +30 at 160x120 (was 0px at -30 with no push).

Blaster projectiles (g_weapon.c/p_weapon.c/cl_fx.c): spawn now literal `G_ProjectSource` from the feet origin (`feet + fwd*24 + right*8`, `z += viewheight-8`), muzzle dlight at `feet + fwd*18 + right*16` radius `200+(rand&31)` pure yellow, in-flight bolt dlight 200 yellow per live bolt (`pumpBoltLights`), trail sparks fixed `0xe0`, SP damage 15→10. No beam for blaster (only railgun draws TE_RAILTRAIL).

Enemies (g_monster.c/g_ai.c/m_move.c): `entityAngles` returns stored yaw (was null → yaw 0), corpses persist + death move plays to last frame and holds, attack choice latched mid-move + FacingIdeal ±45° gate, per-tick yaw clamped via `M_ChangeYaw` port (`MONSTER_YAW_SPEED 20`).
