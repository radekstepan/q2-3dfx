// @q2/testkit — RELEASE-9 box 4: base1 effect inventory + missing-effect controls.
//
// Owns: `packages/testkit` ONLY. Read-only on `packages/server` /
// `packages/game` / `packages/bsp` / `packages/filesystem` / `@q2/math` /
// `@q2/sound` through their real exports (production code paths, never
// mirrors). `apps/web` is never imported (its driver owns the drain→submit
// half of the live path); the sound-queue half is pinned here through the
// headless `@q2/sound` Mixer. No production code is implemented from this
// lane — the M-controls below are the forcing function.
//
// What this covers (RELEASE-9 done-when box 4 + independent teeth for
// boxes 1–3):
//   - INVENTORY: every base1 spawn/trigger firing path that can emit a
//     render/audio effect, enumerated from the REAL base1 lump (Q2_PAK):
//     barrels, blaster-able surfaces/doors, secrets/goals/exit, weapons,
//     monster attacks, target_speaker/splash/explosion/sparks entities,
//     DELAYED/relayed firings. Each producer is classified as implemented
//     [with test name], missing [with control id], or deliberately deferred
//     [with reason]. The map-vs-table comparison fails loudly on drift —
//     new producers, removed producers, or count changes all fail. There is
//     deliberately NO "effects complete" claim: missing rows keep failing
//     controls until their owning lane implements them.
//   - MISSING-EFFECT CONTROLS (M3/M5-M8/M10-M12): each asserted the
//     producer→server event→render/audio link and FAILED until its lane
//     implemented the link (written with `it.fails` so `yarn verify` stayed
//     green while the link was absent). R9F-1..8 flipped all of them to `it`
//     with the roster rows; the `it.fails`-on-implementation tripwire stands
//     for any future missing link.
//   - IMPLEMENTED-PATH CHECKS (M1/M2/M4/M9/E1–E3): links the parallel
//     server lane already owns in-tree (splash bursts, speaker one-shots,
//     timer cadence, damageless-explosive target fire) plus end-to-end
//     visible sequences with real ticks (server event → SV_Drain* →
//     submitted/rendered state or Mixer sound queue).
// NOTE (2026-10-31): the server lane is editing packages/server +
// packages/game in this same tree mid-session; this file resolves `@q2/*`
// through built `dist` output, so rebuild those workspaces after pulling
// their changes before trusting a run (`yarn verify` rebuilds via turbo).
//
// C ground truths (sibling ../external/quake-2-source, GPL-2.0):
//   - G_UseTargets delay/message/killtarget + relay use: game/g_utils.c:173+
//     (DelayedUse think), game/g_trigger.c relay use.
//   - Use_Target_Speaker / SP_target_speaker: game/g_target.c:60-129.
//   - use_target_splash / SP_target_splash (+sounds table): game/g_target.c:322-360.
//   - func_timer_think/use/SP: game/g_func.c:1757-1810.
//   - door_use_areaportals: game/g_func.c:852-863; door_go_up/down sounds:
//     game/g_func.c:387-401; SP_func_door defaults: game/g_func.c:1138+
//     (sounds!=1 -> doors/dr1_strt.wav etc.); button_fire sound:
//     game/g_func.c:728-733 (switches/butn2.wav).
//   - target_explosion_explode/use/SP: game/g_target.c:230-268.
//   - BecomeExplosion1/2: game/g_misc.c:314-335; barrel_delay/explode +
//     SP_misc_explobox: game/g_misc.c:869-960; func_explosive_explode (+
//     G_UseTargets): game/g_misc.c:745-811.
//   - fire_lead (TE_GUNSHOT/TE_SHOTGUN, water TE_SPLASH): game/g_weapon.c:129-199;
//     fire_blaster (TE_BLASTER): game/g_weapon.c:301-345.
//   - soldier_fire: game/m_soldier.c:462-530; infantry_fire: game/m_infantry.c:487+.
//   - light_use / SP_light: game/g_misc.c:545-575.
//   - CL_ParseTEnt cases: client/cl_tent.c:709 TE_BLOOD, 715-717
//     TE_GUNSHOT/SPARKS/BULLET_SPARKS, 753 TE_SHOTGUN, 760 TE_SPLASH, 783
//     TE_LASER_SPARKS, 798 TE_BLASTER, 834 TE_EXPLOSION2, 880 TE_EXPLOSION1.
//
// Skips cleanly without Q2_PAK (source tools/q2-paths.sh). The roster
// self-check + synthetic (pak-free) controls always run; real-map legs are
// describe.runIf(HAS_PAK).

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { PakFile } from '@q2/filesystem';
import { loadBsp } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import {
  MONSTER_HULL_MAXS,
  MONSTER_HULL_MINS,
  mulberry32,
  resetEdictNums,
} from '@q2/game';
import type { Edict } from '@q2/game';
import {
  MASK_PLAYERSOLID_C,
  SV_DamageBarrel,
  SV_DamageMonster,
  SV_DrainSounds,
  SV_DrainSparks,
  SV_DropTraceFor,
  SV_Init,
  SV_PlayerFire,
  SV_SpawnEntities,
  SV_SpawnMonster,
  SV_Tick,
  SV_TraceFor,
  SV_UseMover,
  fireTargets,
} from '@q2/server';
import type { ServerState } from '@q2/server';
import { ATTN_NORM, Mixer } from '@q2/sound';

const Q2_PAK = process.env.Q2_PAK;
const HAS_PAK = !!Q2_PAK && existsSync(Q2_PAK);

// ---------------------------------------------------------------------------
// Roster: every base1 effect producer, enumerated from the real lump
// (snapshot 2026-10-31; the drift test below re-derives it every run).
// group = "<classname>|<key>" with the key scheme of producerKey().
// status: implemented [evidence test] / missing [control id] / deferred [reason].
// ---------------------------------------------------------------------------

type ProducerStatus = 'implemented' | 'missing' | 'deferred';

interface ProducerRow {
  group: string;
  count: number;
  status: ProducerStatus;
  /** Failing control id (missing only). */
  control?: string;
  /** Original handler: C file + function/TE case. */
  handler: string;
  /** Current status evidence: test name (implemented) or reason (deferred). */
  evidence: string;
}

const C_UTILS_DELAY = 'g_utils.c:173 G_UseTargets(delay->DelayedUse)';
const C_SPEAKER = 'g_target.c:60 Use_Target_Speaker / :81 SP_target_speaker';
const C_SPLASH = 'g_target.c:338 use_target_splash / :352 SP_target_splash';
const C_TIMER = 'g_func.c:1771 func_timer_think';
const C_LIGHT = 'g_misc.c:545 light_use (CS_LIGHTS+style)';
const C_TEXPL = 'g_target.c:230 target_explosion_explode / :244 use_target_explosion';
const C_BARREL = 'g_misc.c:887 barrel_explode / :869 SP_misc_explobox';
const C_FEXP = 'g_misc.c:745 func_explosive_explode (+G_UseTargets :801)';
const C_SECRET = 'g_target.c:154 use_target_secret (misc/secret.wav)';
const C_GOAL = 'g_target.c:189 use_target_goal (misc/secret.wav)';
const C_HELP = 'g_target.c:126 Use_Target_Help';
const C_EXIT = 'g_target.c:270 use_target_changelevel';
const C_DOORSND = 'g_func.c:387 door_go_up/down sound_start/end; :1138 SP_func_door defaults';
const C_BTNSND = 'g_func.c:732 button_fire (switches/butn2.wav)';
const C_AREAPORTAL = 'g_func.c:852 door_use_areaportals';
const C_BLOOD = 'g_weapon.c:129 fire_lead flesh branch; cl_tent.c:709 TE_BLOOD';
const C_WATERSPLASH = 'g_weapon.c:168 fire_lead water branch; cl_tent.c:760 TE_SPLASH';
const C_BLASTER = 'g_weapon.c:301 fire_blaster; cl_tent.c:798 TE_BLASTER';
const C_LEAD = 'g_weapon.c:271 fire_bullet / :285 fire_shotgun; cl_tent.c:715 TE_GUNSHOT / :753 TE_SHOTGUN';
const C_SOLDIER = 'm_soldier.c:462 soldier_fire (blaster/shotgun/machinegun per range)';
const C_INFANTRY = 'm_infantry.c:487 infantry_fire (bullets + melee)';
const C_MSG = 'g_utils.c:173 G_UseTargets message branch (centerprint + misc/talk1.wav)';

const ROSTER: ProducerRow[] = [
  // --- Barrels: TE_EXPLOSION1 + debris + explod1 (C_BARREL, BecomeExplosion1) ---
  ...[
    '-1488 1712 -48',
    '-1456 1664 -48',
    '80 808 -128',
    '88 872 -128',
    '-24 864 -128',
    '136 40 0',
    '184 -24 0',
    '1060 -140 -192',
    '950 -198 -192',
  ].map(
    (at): ProducerRow => ({
      group: `misc_explobox|at:${at}`,
      count: 1,
      status: 'implemented',
      handler: `${C_BARREL}; g_misc.c:314 BecomeExplosion1; cl_tent.c:880 TE_EXPLOSION1`,
      evidence: "server base1.test.ts 'barrels: 9 exploboxes at lump positions' + this file E1 (fuse->boom->drain->mixer)",
    }),
  ),
  // --- func_explosive: C-faithful silent damageless blow (debris + target
  // fire, no flash/sound/radius); *20 -> t78 -> brkglas verified on real map. ---
  {
    group: 'func_explosive|model:*20',
    count: 1,
    status: 'implemented',
    handler: C_FEXP,
    evidence: "this file M9 (*20 silent blow fires t78 -> brkglas on real base1)",
  },
  {
    group: 'func_explosive|model:*30',
    count: 1,
    status: 'implemented',
    handler: `${C_FEXP}; cl_tent.c:880 TE_EXPLOSION1`,
    evidence: "server base1.test.ts world-bridge spawn + this file E1 mechanism (fuse->boom; no target chained)",
  },
  // --- Scripted explosions (own delays .1-.4 via server fuses) ---
  { group: 'target_explosion|tn:t149', count: 3, status: 'implemented', handler: C_TEXPL, evidence: 'this file E3 (t70->t151 fuse delays -> explosions + sounds + debris)' },
  { group: 'target_explosion|tn:t150', count: 3, status: 'implemented', handler: C_TEXPL, evidence: 'this file E3 mechanism (fuse delays -> explosions)' },
  { group: 'target_explosion|tn:t151', count: 4, status: 'implemented', handler: C_TEXPL, evidence: 'this file E3 (delayed fuses -> explosions)' },
  { group: 'target_explosion|tn:t154', count: 2, status: 'implemented', handler: C_TEXPL, evidence: 'this file E3 mechanism (fuse delays -> explosions)' },
  // --- Splashes: 12 target_splash, all timer-driven. Server lane implements
  // the producer registry + TE_SPLASH burst (splashes map -> 32 sparks +
  // spark5/6/7.wav); this file's M1 pins the link end to end. ---
  { group: 'target_splash|tn:t1', count: 2, status: 'implemented', handler: `${C_SPLASH}; cl_tent.c:760 TE_SPLASH`, evidence: "server release-9-effects.test.ts 'fires a 32-spark TE_SPLASH burst' + 'fires through the G_UseTargets cascade' + this file M1" },
  ...['t2', 't3', 't41', 't48', 't49', 't50', 't51', 't52', 't53', 't54'].map(
    (tn): ProducerRow => ({
      group: `target_splash|tn:${tn}`,
      count: 1,
      status: 'implemented',
      handler: `${C_SPLASH}; cl_tent.c:760 TE_SPLASH`,
      evidence: "server release-9-effects.test.ts splash legs + this file M1",
    }),
  ),
  // --- Speakers: 57 prestarted loops (loop channel deliberately silent
  // server-side — server lane: "the audio lane owns it"; M3 pins the event),
  // 21 triggered one-shots (implemented: positioned sound queue). ---
  {
    group: 'target_speaker|ambient-loop',
    count: 57,
    status: 'implemented',
    handler: `${C_SPEAKER} (spawnflags&1 prestart: ent->s.sound = noise_index)`,
    evidence: 'server prestart loop-channel records (st.sounds loop entries: start/stop/position) + this file M3',
  },
  {
    group: 'target_speaker|ambient-inert:-1808 1936 216',
    count: 1,
    status: 'deferred',
    handler: C_SPEAKER,
    evidence: 'no SP firing path: oneshot with no targetname, nothing targets it; C links it but it never sounds',
  },
  ...[
    'brittany',
    'speakc',
    'speakd',
    't114',
    't116',
    't117',
    't118',
    't119',
    't122',
    't152',
    't153',
    't70',
    't73',
    't74',
    't78',
    't82',
    't83',
    't84',
    't85',
    't86',
    't87',
  ].map(
    (tn): ProducerRow => ({
      group: `target_speaker|tn:${tn} oneshot`,
      count: 1,
      status: 'implemented',
      handler: C_SPEAKER,
      evidence: "server release-9-effects.test.ts 'one-shot noises play' + this file M2",
    }),
  ),
  ...['t71', 't72', 't79', 't80', 't81'].map(
    (tn): ProducerRow => ({
      group: `target_speaker|tn:${tn} looptoggle`,
      count: 1,
      status: 'implemented',
      handler: `${C_SPEAKER} (spawnflags&3==2 loop toggle)`,
      evidence: 'server Use_Target_Speaker toggle (st.sounds loop add/remove) + this file M3',
    }),
  ),
  // --- Timers: 29 START_ON/triggered drivers (implemented: cadence think +
  // use-toggle; this file's M4 pins periodic splash/speaker events) + 1
  // targetless no-op (deferred). ---
  ...[
    't1', 't114', 't117', 't118', 't119', 't122', 't2', 't3', 't41', 't48',
    't49', 't50', 't51', 't52', 't53', 't54', 't71', 't72', 't73', 't74',
    't79', 't80', 't81', 't82', 't83', 't84', 't85', 't86', 't87',
  ].map(
    (t): ProducerRow => ({
      group: `func_timer|target:${t}`,
      count: 1,
      status: 'implemented',
      handler: `${C_TIMER} (START_ON nextthink + wait/random)`,
      evidence: "server release-9-effects.test.ts 'START_ON timers fire on wait cadence' + this file M4",
    }),
  ),
  {
    group: 'func_timer|target:(none)',
    count: 1,
    status: 'deferred',
    handler: C_TIMER,
    evidence: 'targetless START_ON timer at -1784 1936 216: fires empty G_UseTargets, a no-op by construction',
  },
  // --- Secrets / goal / help / exit ---
  { group: 'target_secret|tn:t76', count: 1, status: 'implemented', handler: C_SECRET, evidence: "server item-pickup.test.ts silencer-take t76 leg (count + misc/secret.wav)" },
  { group: 'target_secret|tn:t77', count: 1, status: 'implemented', handler: C_SECRET, evidence: "server base1.test.ts secret-count legs (foundSecrets + misc/secret.wav)" },
  { group: 'target_secret|tn:t91', count: 1, status: 'implemented', handler: C_SECRET, evidence: "server base1.test.ts 'exit stats: *13 lift button finishes via t91 and counts its secret once'" },
  { group: 'target_goal|tn:t92', count: 1, status: 'implemented', handler: C_GOAL, evidence: 'testkit release-6-hud-live.test.ts goal leg (foundGoals + misc/secret.wav)' },
  { group: 'target_help|tn:t70', count: 2, status: 'implemented', handler: C_HELP, evidence: 'server help.test.ts (message1/2 latch + helpchanged seq) + this file E3' },
  { group: 'target_changelevel|tn:t37', count: 1, status: 'implemented', handler: C_EXIT, evidence: "server base1.test.ts 'exit mechanism: pit-floor overlap fires t37 -> changelevel'" },
  // --- Relays: immediate fire implemented; the delay leg is its own aspect ---
  ...[
    'tn:t153 delay=.3',
    'tn:t2 delay=0',
    'tn:t2 delay=0.1',
    'tn:t3 delay=0',
    'tn:t3 delay=0.1',
    'tn:t49 delay=0',
    'tn:t49 delay=0.1',
    'tn:t50 delay=0',
    'tn:t50 delay=0.1',
    'tn:t51 delay=0',
    'tn:t51 delay=0.1',
    'tn:t70 delay=2',
    'tn:t76 delay=0',
  ].map(
    (k): ProducerRow => ({
      group: `trigger_relay|${k}`,
      count: 1,
      status: 'implemented',
      handler: 'g_trigger.c relay use (immediate G_UseTargets)',
      evidence: "server base1.test.ts 'no door/relay/button use in the lump can start the exit lift except t91' (relay audit)",
    }),
  ),
  // --- Targeted strobe lights (styles 32-36, toggled by the t-relay chains) ---
  ...[
    ['t155', '36'],
    ['t156', '35'],
    ['t157', '34'],
    ['t158', '33'],
    ['t159', '32'],
  ].map(
    ([tn, style]): ProducerRow => ({
      group: `light|tn:${tn} style=${style}`,
      count: 1,
      status: 'implemented',
      handler: C_LIGHT,
      evidence: 'server light_use style record (lightStyles/lightToggles) + this file M6',
    }),
  ),
  // --- Movers: travel implemented, sounds absent ---
  ...['*19', '*31', '*32', '*33'].map(
    (model): ProducerRow => ({
      group: `func_door|model:${model}`,
      count: 1,
      status: 'implemented',
      handler: `${C_DOORSND}; cl_tent.c n/a (positional sounds)`,
      evidence: 'server door_go_up/down leg sounds (dr1_strt/end) + this file M7',
    }),
  ),
  ...['*13', '*34'].map(
    (model): ProducerRow => ({
      group: `func_button|model:${model}`,
      count: 1,
      status: 'implemented',
      handler: C_BTNSND,
      evidence: 'server button_fire sound (switches/butn2.wav) + this file M7',
    }),
  ),
  { group: 'func_train|model:*12', count: 1, status: 'implemented', handler: 'train_next/use (g_func.c); C trains are silent', evidence: "server base1.test.ts 'ships/train/flags: corner chains spawn, ships fly, train waits for *13'" },
  { group: 'func_rotating|model:*29', count: 1, status: 'deferred', handler: 'g_func.c SP_func_door_rotating', evidence: 'no firing path in base1 (no targetname, never used): the fan mesh is static scenery' },
  { group: 'misc_strogg_ship|notarget', count: 3, status: 'implemented', handler: 'misc_strogg_ship_use (g_misc.c); pathtarget flyby sounds ride M2 speakers', evidence: "server base1.test.ts 'ships: teleport-closed loops wrap forever'" },
  // --- Monsters: attacks implemented; flesh-hit blood absent ---
  { group: 'monster_soldier|notarget', count: 6, status: 'implemented', handler: `${C_SOLDIER}; ${C_LEAD}; ${C_BLASTER}`, evidence: "server combat.test.ts 'sustained fire: ss burst is C-true' + base1.test.ts 'runner: start-room soldier ambushes, then closes and fires'" },
  { group: 'monster_soldier|tn:t38', count: 1, status: 'implemented', handler: C_SOLDIER, evidence: 'server item-pickup.test.ts roster legs (TRIGGER_SPAWN wake + attack)' },
  { group: 'monster_soldier|tn:t55', count: 1, status: 'implemented', handler: `${C_SOLDIER} (TRIGGER_SPAWN, woken by the shotgun take)`, evidence: 'server item-pickup.test.ts t55 wake leg' },
  { group: 'monster_infantry|notarget', count: 3, status: 'implemented', handler: C_INFANTRY, evidence: 'server infantry.test.ts + infantry-burst.test.ts (bullets TE_GUNSHOT + muzzle + melee)' },
  { group: 'monster_infantry|tn:t39', count: 1, status: 'implemented', handler: `${C_INFANTRY}; monster_death_use fires t40`, evidence: "server item-pickup.test.ts 'killing t39 alerts t40 via death_use'" },
  { group: 'monster_infantry|tn:t40', count: 1, status: 'implemented', handler: C_INFANTRY, evidence: 'server infantry.test.ts mechanism (TRIGGER_SPAWN ambush)' },
  { group: 'monster_soldier_light|notarget', count: 4, status: 'implemented', handler: C_SOLDIER, evidence: 'server combat.test.ts skin-HP legs (light 20hp) + soldier-fire mechanism' },
  { group: 'monster_soldier_light|tn:t42', count: 1, status: 'implemented', handler: C_SOLDIER, evidence: 'server combat.test.ts soldier-fire mechanism' },
  { group: 'monster_soldier_light|tn:t55', count: 1, status: 'implemented', handler: `${C_SOLDIER} (TRIGGER_SPAWN)`, evidence: 'server item-pickup.test.ts t55 wake leg' },
  // --- Pickups: consume/respawn + Touch_Item target fire implemented ---
  { group: 'weapon_shotgun|notarget', count: 1, status: 'implemented', handler: 'g_items.c Touch_Item (fires t55, wakes soldiers)', evidence: 'server item-pickup.test.ts shotgun-take leg' },
  ...['weapon_bfg', 'weapon_hyperblaster', 'weapon_machinegun', 'weapon_rocketlauncher', 'weapon_supershotgun'].map(
    (c): ProducerRow => ({
      group: `${c}|notarget`,
      count: 1,
      status: 'implemented',
      handler: 'g_items.c Touch_Item (take path shared with live weapons)',
      evidence: 'server item-pickup.test.ts consume/respawn mechanism',
    }),
  ),
  ...[
    ['ammo_bullets', 6],
    ['ammo_cells', 4],
    ['ammo_grenades', 5],
    ['ammo_rockets', 1],
    ['ammo_shells', 9],
  ].map(([c, n]): ProducerRow => ({
    group: `${c}|notarget`,
    count: n as number,
    status: 'implemented',
    handler: 'g_items.c Touch_Item (take + respawn)',
    evidence: 'server item-pickup.test.ts consume/respawn mechanism',
  })),
  ...[
    ['item_adrenaline', 1],
    ['item_armor_combat', 1],
    ['item_armor_jacket', 2],
    ['item_armor_shard', 5],
    ['item_health', 6],
    ['item_health_large', 3],
    ['item_health_small', 9],
    ['item_quad', 1],
    ['item_silencer', 1],
  ].map(([c, n]): ProducerRow => ({
    group: `${c}|notarget`,
    count: n as number,
    status: 'implemented',
    handler: 'g_items.c Touch_Item (take + respawn; silencer fires t76)',
    evidence: 'server item-pickup.test.ts consume/respawn + t76 secret leg',
  })),
  {
    group: 'misc_deadsoldier|notarget',
    count: 12,
    status: 'implemented',
    handler: 'g_misc.c misc_deadsoldier_die (gibs + udeath past -80hp)',
    evidence: "server gibs.test.ts 'the hit reaching -80 minces: 4x meat + head + udeath'",
  },
];

/**
 * Cross-cutting aspects: real firing paths with no per-entity map row (the
 * delay/message/water/areaportal/blood legs ride the rows above). Count 0 =
 * excluded from the map-drift comparison, still pinned by controls.
 */
const ASPECTS: ProducerRow[] = [
  { group: 'aspect:relay/entity delay (DelayedUse)', count: 0, status: 'implemented', handler: C_UTILS_DELAY, evidence: 'server DelayedUse think queue + this file M5' },
  { group: 'aspect:trigger/entity message centerprint + talk1', count: 0, status: 'implemented', handler: C_MSG, evidence: 'server G_UseTargets message branch (centerprints + talk1) + this file M10 (*15 ladder msg, *18 crouch msg, t76-relay msg)' },
  { group: 'aspect:hitscan vs water TE_SPLASH', count: 0, status: 'implemented', handler: C_WATERSPLASH, evidence: 'server fire_lead water branch (splash-class sparks, color per contents) + this file M11' },
  { group: 'aspect:door areaportal open/close', count: 0, status: 'implemented', handler: C_AREAPORTAL, evidence: 'server door_use_areaportals record + this file M12 (door *19 -> t69)' },
  { group: 'aspect:blood on hitscan flesh hits', count: 0, status: 'implemented', handler: C_BLOOD, evidence: 'server fire_lead flesh branch (blood-class sparks; blaster flesh stays event-free) + this file M8' },
];

const CONTROL_IDS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M12'];

// ---------------------------------------------------------------------------
// Producer enumeration (mirrors the snapshot script; key scheme is normative).
// ---------------------------------------------------------------------------

const EFFECT_CLASSES = new Set([
  'misc_explobox', 'func_explosive', 'target_explosion', 'target_splash',
  'target_speaker', 'func_timer', 'target_secret', 'target_goal', 'target_help',
  'target_changelevel', 'trigger_relay', 'light', 'monster_soldier',
  'monster_infantry', 'monster_soldier_light', 'weapon_blaster', 'weapon_shotgun',
  'weapon_machinegun', 'weapon_supershotgun', 'weapon_hyperblaster',
  'weapon_rocketlauncher', 'weapon_bfg', 'func_door', 'func_button', 'func_train',
  'func_rotating', 'misc_strogg_ship', 'misc_deadsoldier', 'ammo_shells',
  'ammo_bullets', 'ammo_cells', 'ammo_rockets', 'ammo_grenades', 'item_health',
  'item_health_small', 'item_health_large', 'item_armor_shard', 'item_armor_jacket',
  'item_armor_combat', 'item_adrenaline', 'item_silencer', 'item_quad',
]);

function parseLumpDicts(text: string): Array<Record<string, string>> {
  const dicts: Array<Record<string, string>> = [];
  for (const m of text.matchAll(/\{([^}]*)\}/g)) {
    const d: Record<string, string> = {};
    for (const kv of m[1]!.matchAll(/"([^"]*)"\s+"([^"]*)"/g)) d[kv[1]!] = kv[2]!;
    if (d['classname']) dicts.push(d);
  }
  return dicts;
}

/** Normative group-key scheme (must match the ROSTER snapshot script). */
function producerKey(classname: string, d: Record<string, string>): string | null {
  const tn = d['targetname'];
  if (classname === 'target_speaker') {
    if (tn) {
      const mode = ((Number.parseInt(d['spawnflags'] ?? '0', 10) || 0) & 3) === 2 ? 'looptoggle' : 'oneshot';
      return `tn:${tn} ${mode}`;
    }
    return ((Number.parseInt(d['spawnflags'] ?? '0', 10) || 0) & 3) === 1
      ? 'ambient-loop'
      : `ambient-inert:${d['origin'] ?? ''}`;
  }
  if (classname === 'func_timer') return `target:${d['target'] ?? '(none)'}`;
  if (classname === 'trigger_relay') return `tn:${tn} delay=${d['delay'] ?? '0'}`;
  if (classname === 'light') return `tn:${tn} style=${d['style'] ?? '?'}`;
  if (
    tn &&
    (classname === 'target_splash' || classname === 'target_explosion' ||
      classname === 'target_secret' || classname === 'target_goal' ||
      classname === 'target_help' || classname === 'target_changelevel' ||
      classname === 'monster_soldier' || classname === 'monster_infantry' ||
      classname === 'monster_soldier_light')
  ) {
    return `tn:${tn}`;
  }
  if (d['model']) return `model:${d['model']}`;
  if (classname === 'misc_explobox') return `at:${d['origin'] ?? ''}`;
  return 'notarget';
}

function enumerateProducers(lump: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const d of parseLumpDicts(lump)) {
    const c = d['classname']!;
    if (!EFFECT_CLASSES.has(c)) continue;
    if (c === 'light' && !d['targetname']) continue;
    const key = producerKey(c, d);
    if (key === null) continue;
    const group = `${c}|${key}`;
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return counts;
}

function classify(group: string): ProducerRow | undefined {
  return ROSTER.find((r) => r.group === group) ?? ASPECTS.find((r) => r.group === group);
}

// ---------------------------------------------------------------------------
// Asset-free leg: the table itself must be well-formed (no pak needed).
// ---------------------------------------------------------------------------

describe('RELEASE-9 inventory table self-check (no pak)', () => {
  it('every roster row is classified with handler + evidence, every missing row names a control', () => {
    const problems: string[] = [];
    for (const r of [...ROSTER, ...ASPECTS]) {
      if (r.status !== 'implemented' && r.status !== 'missing' && r.status !== 'deferred') {
        problems.push(`${r.group}: bad status ${r.status}`);
      }
      if (!r.handler) problems.push(`${r.group}: empty handler`);
      if (!r.evidence) problems.push(`${r.group}: empty evidence`);
      if (r.status === 'missing') {
        if (!r.control || !CONTROL_IDS.includes(r.control)) {
          problems.push(`${r.group}: missing row without a valid control id`);
        }
      }
      if (r.status === 'implemented' && r.control) {
        problems.push(`${r.group}: implemented row must not name a control`);
      }
    }
    expect(problems, `roster malformed:\n  ${problems.join('\n  ')}`).toEqual([]);
    console.log(
      `[release-9] roster: ${ROSTER.length} map rows + ${ASPECTS.length} aspects; ` +
        `implemented=${ROSTER.filter((r) => r.status === 'implemented').length} ` +
        `missing=${ROSTER.filter((r) => r.status === 'missing').length} ` +
        `deferred=${ROSTER.filter((r) => r.status === 'deferred').length}`,
    );
  });

  it('map-row groups are unique (no double counting)', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const r of ROSTER) {
      if (seen.has(r.group)) dupes.push(r.group);
      seen.add(r.group);
    }
    expect(dupes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Real-map leg: the lump must match the roster exactly (drift fails loudly).
// ---------------------------------------------------------------------------

describe.runIf(HAS_PAK)('RELEASE-9 base1 effect inventory (real map)', () => {
  it('enumerated producers match the classified roster (no blanket claim)', { timeout: 120000 }, () => {
    const raw = readFileSync(Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const pak = new PakFile(buf);
    const map = loadBsp(pak.readFile('maps/base1.bsp')) as BspMap;
    const lump = map.entities as unknown as string;
    const actual = enumerateProducers(lump);
    const expected = new Map(ROSTER.map((r) => [r.group, r.count]));
    const lines: string[] = [];
    const missing: string[] = [];
    const extra: string[] = [];
    for (const [group, count] of expected) {
      const got = actual.get(group) ?? 0;
      if (got !== count) missing.push(`${group}: roster says ${count}, map has ${got}`);
      const row = classify(group)!;
      lines.push(`${row.status.toUpperCase().padEnd(11)} ${group} x${got}${row.status === 'missing' ? ` [${row.control}]` : ''}`);
    }
    for (const [group, count] of actual) {
      if (!expected.has(group)) extra.push(`${group} x${count} (UNCLASSIFIED producer in the map!)`);
    }
    console.log(`[release-9] base1 effect producers (${actual.size} groups):\n  ${lines.join('\n  ')}`);
    expect(
      [...missing, ...extra],
      `inventory drift (update ROSTER + file follow-up cards):\n  ${[...missing, ...extra].join('\n  ')}`,
    ).toEqual([]);
    // The roster is complete: every enumerated producer is implemented and
    // pinned by a passing control above (R9F-1..8 landed the last missing
    // links). Zero open rows is the earned state, not a blanket claim.
    const openCount = ROSTER.filter((r) => r.status === 'missing').length;
    expect(openCount, 'all enumerated producers are implemented (no missing rows remain)').toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Harness: real base1 boot (production setup, read-only imports only).
// ---------------------------------------------------------------------------

function modelBounds(map: BspMap, n: number): { mins: Float32Array; maxs: Float32Array } {
  const mm = map as unknown as { modelsMins: Float32Array; modelsMaxs: Float32Array };
  return {
    mins: new Float32Array([mm.modelsMins[n * 3]!, mm.modelsMins[n * 3 + 1]!, mm.modelsMins[n * 3 + 2]!]),
    maxs: new Float32Array([mm.modelsMaxs[n * 3]!, mm.modelsMaxs[n * 3 + 1]!, mm.modelsMaxs[n * 3 + 2]!]),
  };
}

function bootBase1(): { st: ServerState; map: BspMap } {
  const raw = readFileSync(Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const pak = new PakFile(buf);
  const map = loadBsp(pak.readFile('maps/base1.bsp')) as BspMap;
  resetEdictNums();
  const st = SV_Init();
  SV_SpawnEntities(
    st,
    map.entities as unknown as string,
    (model) => {
      if (!model.startsWith('*')) return null;
      const n = Number.parseInt(model.slice(1), 10);
      if (!Number.isFinite(n)) return null;
      return modelBounds(map, n);
    },
    SV_DropTraceFor(map),
  );
  return { st, map };
}

function aimAngles(eye: Vec3, target: Vec3): Vec3 {
  const dx = target[0]! - eye[0]!;
  const dy = target[1]! - eye[1]!;
  const dz = target[2]! - eye[2]!;
  const len = Math.hypot(dx, dy, dz) || 1;
  const yaw = (Math.atan2(dy, dx) * 180) / Math.PI;
  const pitch = (-Math.asin(dz / len) * 180) / Math.PI;
  return v3(pitch, yaw, 0);
}

/** Feed drained server sounds through the headless mixer (sound-queue link). */
function mixDrainedSounds(st: ServerState, at: Vec3): ReturnType<Mixer['mix']> {
  const drained = SV_DrainSounds(st);
  const mixer = new Mixer();
  mixer.setListener(at, [0, -1, 0]);
  for (const s of drained) {
    mixer.startSound({
      origin: [s.pos[0]!, s.pos[1]!, s.pos[2]!],
      fixedOrigin: false,
      entnum: 7,
      attenuation: ATTN_NORM,
      masterVol: 1,
      loop: false,
      name: s.name,
    });
  }
  return mixer.mix();
}

// ---------------------------------------------------------------------------
// Missing-effect controls (all implemented by R9F-1..8; formerly `it.fails`
// until their lane landed). Each pins the producer→server event→render/audio
// link end to end.
// ---------------------------------------------------------------------------

describe('RELEASE-9 missing-effect controls (fail until implemented)', () => {
  it('M1 (implemented): firing a target_splash emits a TE_SPLASH-class server event', () => {
    // C: use_target_splash writes TE_SPLASH (count 32 default) + multicasts.
    // Server lane owns the producer (splashes map -> sparks + spark5/6/7.wav);
    // this pins the link end to end on a synthetic lump.
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{ "classname" "trigger_once" "target" "t9" }
       { "classname" "target_splash" "targetname" "t9" "origin" "0 0 64" "angle" "-2" "sounds" "1" }`,
    );
    const trig = st.entities.find((e) => !e.freed && e.classname === 'trigger_once')!;
    const before = st.sparks.length;
    fireTargets(st, trig);
    const gained = st.sparks.length - before;
    console.log(`[release-9] M1 splash sparks gained=${gained} (C: 32px TE_SPLASH burst)`);
    expect(gained, 'target_splash must emit a TE_SPLASH-class spark burst').toBeGreaterThan(0);
  });

  it('M2 (implemented): firing a target_speaker emits its positioned one-shot sound', () => {
    // C: Use_Target_Speaker positioned_sound (CHAN_VOICE, reliable iff flag 4).
    // Server lane owns the one-shot queue; looped speakers stay on the loop
    // channel by design (M3 pins that missing event).
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{ "classname" "trigger_once" "target" "t116" }
       { "classname" "target_speaker" "targetname" "t116" "noise" "world/voice11.wav" "origin" "-8 -272 80" }`,
    );
    const trig = st.entities.find((e) => !e.freed && e.classname === 'trigger_once')!;
    fireTargets(st, trig);
    const names = st.sounds.map((s) => s.name);
    console.log(`[release-9] M2 sounds after t116 fire: [${names.join(', ')}]`);
    expect(names, 't116 speaker must queue world/voice11.wav').toContain('world/voice11.wav');
  });

  it('M3: prestarted looped speakers register an ambient loop (s.sound)', () => {
    // C SP_target_speaker (spawnflags&1): ent->s.sound = noise_index at spawn;
    // the mixer loops it until toggled. 57 base1 ambients ride this path.
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{ "classname" "target_speaker" "noise" "world/amb7.wav" "origin" "0 0 64" "spawnflags" "1" }`,
    );
    for (let i = 0; i < 5; i++) SV_Tick(st, 0.1);
    const loops = st.sounds.filter(
      (s) => (s as unknown as { loop?: boolean }).loop === true && s.name === 'world/amb7.wav',
    );
    console.log(`[release-9] M3 loop-flagged amb7 entries=${loops.length} (total sounds=${st.sounds.length})`);
    expect(loops.length, 'looped-on speaker must register a looping ambient entry').toBeGreaterThan(0);
  });

  it('M5: trigger_relay delay defers firing (DelayedUse, G_UseTargets)', () => {
    // C: ent->delay spawns a DelayedUse that fires at level.time + delay.
    // The 0.1s t2/t50/t51/t3/t49 pairs + t153 (.3) + t70 (2) all ride this.
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{ "classname" "trigger_once" "target" "a" }
       { "classname" "trigger_relay" "targetname" "a" "target" "b" "delay" "0.1" }
       { "classname" "target_secret" "targetname" "b" "message" "relay-delay probe" }`,
    );
    const trig = st.entities.find((e) => !e.freed && e.classname === 'trigger_once')!;
    fireTargets(st, trig);
    console.log(`[release-9] M5 foundSecrets immediately after delayed relay fire=${st.foundSecrets}`);
    expect(st.foundSecrets, 'delayed relay must NOT fire synchronously (DelayedUse think pending)').toBe(0);
    for (let i = 0; i < 3; i++) SV_Tick(st, 0.1);
    expect(st.foundSecrets, 'delayed relay must fire after its delay elapses').toBe(1);
  });

  it('M6: firing a targeted light toggles its style (light_use CS_LIGHTS)', () => {
    // C light_use flips CS_LIGHTS+style between "m" (on) and "a" (off).
    // t155-t159 strobe with the splash relays every few seconds.
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{ "classname" "trigger_once" "target" "t159" }
       { "classname" "light" "targetname" "t159" "style" "32" "light" "100" "origin" "-456 -12 48" }`,
    );
    const trig = st.entities.find((e) => !e.freed && e.classname === 'trigger_once')!;
    fireTargets(st, trig);
    const toggles = (st as unknown as { lightToggles?: Array<{ style: number }> }).lightToggles ?? [];
    console.log(`[release-9] M6 light-toggle records=${toggles.length} (lane defines the exact shape)`);
    expect(toggles.length, 'light_use must record a style-32 toggle for the driver').toBeGreaterThan(0);
  });

  it('M8: bullet hits on flesh emit a blood-class impact event (TE_BLOOD)', () => {
    // C fire_lead flesh branch: TE_BLOOD at the hit. TS resolves damage but
    // records no impact event (SV_DamageMonster only pushes gib sound + gibs).
    const st = SV_Init();
    const open: import('@q2/game').TraceFn = (start, _mins, _maxs, end) => ({
      fraction: 1,
      endpos: v3(end[0], end[1], end[2]),
      planeNormal: v3(0, 0, 1),
      allsolid: false,
      startsolid: false,
      entityNum: -1,
      contents: 0,
    });
    const m = SV_SpawnMonster(st, 'monster_soldier', v3(150, 0, 24));
    const rand = mulberry32(0x9e37);
    const eye = v3(0, 0, 22);
    const center = v3(
      m.edict.origin[0],
      m.edict.origin[1],
      m.edict.origin[2]! + (MONSTER_HULL_MINS[2]! + MONSTER_HULL_MAXS[2]!) / 2,
    );
    let damaged = false;
    for (let i = 0; i < 8 && !damaged; i++) {
      SV_PlayerFire(st, 'weapon_shotgun', {
        eye,
        feet: v3(0, 0, 0),
        angles: aimAngles(eye, center),
        viewheight: 22,
        ammo: 10,
        trace: open,
        rand,
      });
      damaged = m.state.health < 30;
    }
    expect(damaged, 'setup: pellets must actually hit the soldier').toBe(true);
    console.log(`[release-9] M8 flesh-hit sparks=${st.sparks.length} (C: TE_BLOOD burst per hit)`);
    expect(st.sparks.length, 'flesh hits must emit a blood-class impact event').toBeGreaterThan(0);
  });

  it('M10: trigger/entity messages surface a centerprint + talk1 (G_UseTargets)', () => {
    // C prints ent->message + talk1.wav for every used entity with a message
    // (*15 ladder hint, *18 crouch hint, the t76 relay line).
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{ "classname" "trigger_once" "message" "Press move up to climb ladder." }`,
    );
    const trig = st.entities.find((e) => !e.freed && e.classname === 'trigger_once')!;
    fireTargets(st, trig);
    const prints = (st as unknown as { centerprints?: string[] }).centerprints ?? [];
    const names = st.sounds.map((s) => s.name);
    console.log(`[release-9] M10 centerprints=${JSON.stringify(prints)} talk1=${names.includes('misc/talk1.wav')}`);
    expect(prints.length, 'used entity message must surface a centerprint').toBeGreaterThan(0);
    expect(names, 'used entity message must queue misc/talk1.wav').toContain('misc/talk1.wav');
  });

  it('M11: hitscan entering water emits a TE_SPLASH-class event', () => {
    // C fire_lead water branch: TE_SPLASH (8px, blue/brown/slime/lava). TS
    // pellet resolution never consulted contents, so pool crossings were dry.
    // NOTE (R9F-7): the control as written passed contents:1 (SOLID in every
    // contents space) and ammo:0 (an unfired shell emits nothing). The
    // C-faithful shape keys splash on the BSP water bits traceBox reports
    // (WATER 32; SLIME 16; LAVA 8 — q_shared.h, production-trace space), so
    // the control now carries contents:32 (blue water) and a live shell.
    const st = SV_Init();
    const waterTrace: import('@q2/game').TraceFn = (start, _mins, _maxs, end) => ({
      fraction: 0.5,
      endpos: v3(
        start[0]! + (end[0]! - start[0]!) * 0.5,
        start[1]! + (end[1]! - start[1]!) * 0.5,
        start[2]! + (end[2]! - start[2]!) * 0.5,
      ),
      planeNormal: v3(0, 0, 1),
      allsolid: false,
      startsolid: false,
      entityNum: -1,
      contents: 32,
    });
    SV_PlayerFire(st, 'weapon_shotgun', {
      eye: v3(0, 0, 22),
      feet: v3(0, 0, 0),
      angles: v3(0, 0, 0),
      viewheight: 22,
      ammo: 10,
      trace: waterTrace,
      rand: mulberry32(7),
    });
    const splashes = st.sparks.filter((s) => (s as unknown as { splash?: string }).splash !== undefined);
    console.log(`[release-9] M11 water-splash events=${splashes.length} (wall puffs=${st.sparks.length})`);
    expect(splashes.length, 'water impacts must emit a TE_SPLASH-class event, not a dry puff').toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Real-map controls (pak-gated; same implemented contract as above).
// ---------------------------------------------------------------------------

describe.runIf(HAS_PAK)('RELEASE-9 real-map missing controls (fail until implemented)', () => {
  it('M4 (implemented): START_ON func_timers drive periodic splash/speaker/light events', { timeout: 180000 }, () => {
    // 29 START_ON timers (wait 2.8-17s + random) fire splash bursts, one-shot
    // speakers and loop toggles through the in-tick cadence. Unattended ticks
    // must therefore accumulate sounds/sparks; server lane owns the cadence.
    const { st } = bootBase1();
    expect(
      st.entities.some((e) => !e.freed && e.classname === 'func_timer'),
      'setup: base1 must spawn func_timer edicts',
    ).toBe(true);
    expect(st.timers.length, 'setup: timers register in the server cadence table').toBe(30);
    const s0 = st.sounds.length;
    const p0 = st.sparks.length;
    for (let i = 0; i < 300; i++) SV_Tick(st, 0.1);
    const gained = st.sounds.length - s0 + (st.sparks.length - p0);
    console.log(
      `[release-9] M4 timer-driven events over 30 unattended ticks: sounds+${st.sounds.length - s0} sparks+${st.sparks.length - p0}`,
    );
    expect(gained, 'timers must drive periodic map effects within 30s').toBeGreaterThan(0);
  });

  it('M7: linear doors/buttons queue their move sounds', { timeout: 120000 }, () => {
    // C: doors/dr1_strt.wav on leg start (+middle/end), switches/butn2.wav.
    const { st } = bootBase1();
    const door = st.movers.find((m) => m.ent.model === '*32')!;
    SV_UseMover(st, door);
    const button = st.movers.find((m) => m.ent.model === '*34')!;
    SV_UseMover(st, button);
    const names = st.sounds.map((s) => s.name);
    console.log(`[release-9] M7 sounds after *32 + *34 use: [${names.join(', ')}]`);
    expect(names, 'door leg must queue doors/dr1_strt.wav').toContain('doors/dr1_strt.wav');
    expect(names, 'button press must queue switches/butn2.wav').toContain('switches/butn2.wav');
  });

  it('M9 (implemented): damageless func_explosive blow fires its target (t78 -> brkglas)', { timeout: 120000 }, () => {
    // C func_explosive_explode: G_UseTargets then BecomeExplosion1; with dmg 0
    // the blow is silent (debris + target, no flash/sound/radius). *20 targets
    // t78 (brkglas speaker). Server lane owns the blow; this pins the real-map
    // chain end to end.
    const { st, map } = bootBase1();
    const barrel = st.barrels.find((b) => b.isFunc && b.edict.target === 't78');
    expect(barrel, 'setup: *20 func_explosive barrel with target t78 must exist').toBeDefined();
    SV_DamageBarrel(st, barrel!, 100000);
    const trace = SV_TraceFor(map, MASK_PLAYERSOLID_C);
    const game = {
      player: {
        pos: v3(5000, 5000, 500),
        mins: v3(-16, -16, -24),
        maxs: v3(16, 16, 32),
        view: 22,
      },
      trace,
      rand: mulberry32(0x20),
    };
    for (let i = 0; i < 5; i++) SV_Tick(st, 0.1, game);
    const names = st.sounds.map((s) => s.name);
    console.log(`[release-9] M9 sounds after *20 blow: [${names.join(', ')}]`);
    expect(barrel!.edict.freed, 'the brush frees at blow time').toBe(true);
    expect(st.debris.length, 'damageless blow still throws debris').toBeGreaterThan(0);
    expect(st.explosions.length, 'damageless blow records no explosion flash').toBe(0);
    expect(names, '*20 blow must fire t78 -> world/brkglas.wav').toContain('world/brkglas.wav');
  });

  it('M12: door *19 use drives its areaportal (t69)', { timeout: 120000 }, () => {
    // C door_use_areaportals opens/closes func_areaportal t69 with the door.
    const { st } = bootBase1();
    const door = st.movers.find((m) => m.ent.model === '*19')!;
    SV_UseMover(st, door);
    const portals = (st as unknown as { areaPortals?: Record<string, boolean> }).areaPortals ?? {};
    console.log(`[release-9] M12 areaportal records=${JSON.stringify(portals)}`);
    expect(Object.keys(portals).length, 'door use must record the t69 areaportal state').toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end spot checks (implemented paths, real ticks, must PASS).
// ---------------------------------------------------------------------------

describe.runIf(HAS_PAK)('RELEASE-9 implemented-path sequences (must pass)', () => {
  it('E1: barrel fuse -> explosion event -> drain -> mixer (real base1)', { timeout: 120000 }, () => {
    const { st, map } = bootBase1();
    const barrel = st.barrels[0]!;
    expect(barrel.edict.classname).toBe('misc_explobox');
    expect(SV_DamageBarrel(st, barrel, 100000), 'lethal hit latches the 0.2s fuse').toBe(true);
    const trace = SV_TraceFor(map, MASK_PLAYERSOLID_C);
    const game = {
      player: {
        pos: v3(5000, 5000, 500),
        mins: v3(-16, -16, -24),
        maxs: v3(16, 16, 32),
        view: 22,
      },
      trace,
      rand: mulberry32(0xe1),
    };
    for (let i = 0; i < 4; i++) SV_Tick(st, 0.1, game);
    expect(st.explosions.length, 'fuse blow records an explosion event').toBeGreaterThan(0);
    const boom = st.explosions[0]!;
    expect(['explosion1', 'explosion2']).toContain(boom.kind);
    expect(st.debris.length, 'barrel blow throws debris chunks').toBeGreaterThan(0);
    // C cl_tent.c registrations: TE_EXPLOSION1 -> weapons/rocklx1a.wav,
    // TE_EXPLOSION2 -> weapons/grenlx1a.wav (no explod1 fallback in C).
    const wantBoomSound = boom.kind === 'explosion2' ? 'weapons/grenlx1a.wav' : 'weapons/rocklx1a.wav';
    expect(
      st.sounds.some((s) => s.name === wantBoomSound),
      `barrel blow queues ${wantBoomSound} for ${boom.kind}`,
    ).toBe(true);
    const sparks = SV_DrainSparks(st);
    expect(sparks.length, 'drain hands the 256-spark burst to the driver').toBeGreaterThan(0);
    const mixed = mixDrainedSounds(st, v3(boom.pos[0], boom.pos[1], boom.pos[2]));
    const boomMix = mixed.filter((m) => m.name === wantBoomSound);
    expect(boomMix.length, 'sound queue mixes the explosion audible').toBeGreaterThan(0);
    expect(boomMix[0]!.left + boomMix[0]!.right, 'mixed gain is positive at the source').toBeGreaterThan(0);
    console.log(
      `[release-9] E1 barrel boom kind=${boom.kind} explosions=${st.explosions.length} sparks=${sparks.length} debris=${st.debris.length} mixed=${mixed.length}`,
    );
  });

  it('E2: blaster wall impact -> flash + sparks + lashit -> drain -> mixer', { timeout: 120000 }, () => {
    const { st, map } = bootBase1();
    const trace = SV_TraceFor(map, MASK_PLAYERSOLID_C);
    const feet = v3(128, -320, 32);
    const eye = v3(128, -320, 54);
    const rand = mulberry32(0xb2);
    const res = SV_PlayerFire(st, 'weapon_blaster', {
      eye,
      feet,
      angles: v3(80, 0, 0),
      viewheight: 22,
      ammo: 0,
      trace,
      rand,
    });
    expect(res.fired, 'blaster must fire').toBe(true);
    const game = {
      player: {
        pos: feet,
        mins: v3(-16, -16, -24),
        maxs: v3(16, 16, 32),
        view: 22,
      },
      trace,
      rand,
    };
    for (let i = 0; i < 30 && st.bolts.length > 0; i++) SV_Tick(st, 0.1, game);
    expect(st.bolts.length, 'bolt must terminate on the floor (no orphans)').toBe(0);
    expect(
      st.explosions.some((e) => e.kind === 'blaster'),
      'impact records the TE_BLASTER touch flash',
    ).toBe(true);
    expect(st.sparks.length, 'impact records spark burst').toBeGreaterThan(0);
    expect(
      st.sounds.some((s) => s.name === 'weapons/lashit.wav'),
      'impact queues weapons/lashit.wav',
    ).toBe(true);
    expect(
      st.sounds.some((s) => s.name === 'weapons/blastf1a.wav'),
      'fire queues weapons/blastf1a.wav',
    ).toBe(true);
    const mixed = mixDrainedSounds(st, eye);
    expect(mixed.length, 'sound queue mixes fire + impact audible').toBeGreaterThan(0);
    console.log(
      `[release-9] E2 blaster impact sparks=${st.sparks.length} explosions=${st.explosions.length} mixed=${mixed.length}`,
    );
  });

  it('E3: t70 chain -> help latch + relay cascade + delayed explosion fuses -> boom', { timeout: 120000 }, () => {
    // t70 = 2 helps + voice speaker (M2) + relay (2s delay, M5) -> t151
    // target_explosion charges. M5 made the relay leg DelayedUse, so t151 is
    // reached through the tick-think (21 ticks cover the 2s delay), not the
    // synchronous cascade; the fuse half still runs through the production
    // SV_Tick entry point fireExplosionTarget.
    const { st, map } = bootBase1();
    const trace = SV_TraceFor(map, MASK_PLAYERSOLID_C);
    const user = { target: 't70', classname: 'trigger_once' } as unknown as Edict;
    fireTargets(st, user);
    expect(st.helpMessage1, 't70 latches help1 (Establish communication)').toContain('Establish communication');
    expect(st.helpMessage2, 't70 latches help2 (Locate base installation)').toContain('Locate base installation');
    expect(st.helpChangedSeq, 'each help firing bumps the seq').toBe(2);
    const game = {
      player: {
        pos: v3(5000, 5000, 500),
        mins: v3(-16, -16, -24),
        maxs: v3(16, 16, 32),
        view: 22,
      },
      trace,
      rand: mulberry32(0x70),
    };
    for (let i = 0; i < 20; i++) SV_Tick(st, 0.1, game);
    expect(st.fuses.length, 't70 delay elapses -> t151 charges arm as fuses').toBe(4);
    for (let i = 0; i < 6; i++) SV_Tick(st, 0.1, game);
    expect(st.explosions.length, 't151 fuses blow into explosion events').toBe(4);
    expect(
      st.sounds.some((s) => s.name === 'weapons/rocklx1a.wav' || s.name === 'weapons/grenlx1a.wav'),
      't151 blows queue the TE-kind explosion sound',
    ).toBe(true);
    const mixed = mixDrainedSounds(st, v3(0, 0, 100));
    expect(mixed.length, 'sound queue mixes the scripted booms audible').toBeGreaterThan(0);
    console.log(
      `[release-9] E3 t70 chain explosions=${st.explosions.length} mixed=${mixed.length} (relay delay itself is M5)`,
    );
  });
});
