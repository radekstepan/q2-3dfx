// @q2/server — SV_: world state, entity spawning, 10Hz tick. M5.2 owns this.
// In-process server: SV_Tick advances level.time by SERVER_DT (0.1s) and
// runs entities (movers, triggers). Quake coords/angles per BRAIN.md §5.

import { SERVER_DT } from '@q2/config';
import {
  DoRespawn,
  EXPLOBOX_MAXS,
  EXPLOBOX_MINS,
  MONSTER_HULL_MAXS,
  MONSTER_HULL_MINS,
  MONSTER_STEP_HEIGHT,
  MOVER_BOTTOM,
  MOVER_GOING_DOWN,
  MOVER_GOING_UP,
  MOVER_TOP,
  MOVER_WAITING,
  SetRespawn,
  barrelDebrisSpeeds,
  barrelFuseAt,
  AIR_GRACE,
  blasterMuzzle,
  blasterSpawn,
  bspPointContentsFor,
  withPmoveContents,
  doorTravel,
  moveDirForAngle,
  explosionBaseframe,
  explosionFrames,
  findWeapon,
  fireWeapon,
  funcExplosiveDebris,
  monsterChaseMove,
  monsterFlashOffset,
  monsterLocomotion,
  monsterMoveOf,
  monsterPain,
  monsterThink,
  monsterYawTo,
  mulberry32,
  moverThink,
  moverUse,
  muzzleRadius,
  makeWorldEffectsState,
  parseEntities,
  parseFloat,
  parseVec3,
  projectSource,
  radiusDamageAttackerPoints,
  radiusDamagePoints,
  radiusDamageRadius,
  respawnDelayFor,
  sampleWaterLevel,
  soldierHealthForSkin,
  resolveBoltSpawn,
  resetEdictNums,
  soldierWeaponForSkin,
  updateWorldEffects,
  spawnButton,
  spawnDoor,
  spawnEdict,
  spawnExplosive,
  spawnMonster,
  spawnPlat,
  spawnTrigger,
  targetExplosionFuseAt,
  trailInit,
  triggerTouch,
  BOLT_LIFE,
  BOLT_SPEED,
  BLASTER_TRAIL_COLOR,
  GIB_SOUND,
  DEADSOLDIER_GIB_MODELS,
  DEADSOLDIER_GIB_SOUND,
  damageDeadsoldier,
  SUIT_AIR_SECONDS,
  SUIT_BREATH_PERIOD,
  SUIT_BREATH_SOUNDS,
  SUIT_WARN_SECONDS,
  SUIT_WARN_SOUND,
  suitSizzleDamage,
  CONTENTS_LAVA as PMOVE_CONTENTS_LAVA,
  CONTENTS_SLIME as PMOVE_CONTENTS_SLIME,
  HITSCAN_TRACER_COLOR,
  SOLDIER_WEAPON_STATS,
  machinegunKick,
  infantryMeleeDamage,
  infantryDeathSprayAngles,
  traceHitSky,
  INFANTRY_C,
  INFANTRY_GUN_SOUND,
  INFANTRY_COCK_SOUND,
  INFANTRY_MELEE_SOUND,
  INFANTRY_SWING_SOUND,
  GUNNER_GRENADE_SOUND,
  MZ2_INFANTRY_MACHINEGUN_1,
  MZ2_INFANTRY_MACHINEGUN_2,
  INFANTRY_DEATH_SPRAY_FIRST_FRAME,
  MZ2_GUNNER_GRENADE_1,
  MZ2_GUNNER_MACHINEGUN_1,
  MZ2_SOLDIER_BLASTER_1,
  MZ2_SOLDIER_MACHINEGUN_1,
  MZ2_SOLDIER_MACHINEGUN_4,
  MZ2_SOLDIER_SHOTGUN_1,
  SOLID_BBOX,
  SOLID_NOT,
  SOLID_TRIGGER,
  MOVETYPE_NONE,
  MOVETYPE_STEP,
} from '@q2/game';
import type {
  AttackChoice,
  Edict,
  MonsterKind,
  MonsterNav,
  MonsterState,
  Mover,
  PlayerTrail,
  PointContentsFn,
  TraceFn,
  Trigger,
  WorldEffectsState,
} from '@q2/game';
import {
  arriveCombatPoint,
  armInfantryCock,
  armSoldierBurst,
  burstHoldFrozen,
  checkDodges,
  deathFireEvent,
  duckHoldFrozen,
  duckShootEvent,
  maybeBurstRefire,
  acquireSight,
  arrivePatrol,
  monsterHullMaxs,
  patrolCornersOf,
  patrolStart,
  patrolWalkMove,
  pursueGoal,
  reactionAt,
  resolveCombatPoint,
  separationOffset,
  skinOf,
  sustainedFireFrame,
  trailUpkeep,
} from './monster-ai.js';
import type { CombatPoint } from './monster-ai.js';
import {
  setPmoveWorld,
} from '@q2/game';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import { AngleVectors } from '@q2/math';
import { DIST_EPSILON, traceBox } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import {
  CRUSH_DAMAGE,
  DOOR_SOUND_END,
  DOOR_SOUND_START,
  MOVER_TOUCH_DEBOUNCE,
  applyTeamMoveSpeeds,
  doorTouchUse,
  rotThink,
  rotUse,
  secretThink,
  secretUse,
  spawnRotDoor,
  spawnSecretDoor,
} from './doors.js';
import type { RotMover, SecretMover } from './doors.js';
import {
  BUTTON_34_SHIFT,
  BUTTON_TOUCH_SLOP,
  BUTTON_USE_DOT,
  BUTTON_USE_REACH,
  buttonCanFire,
  displacedCenter,
  isButtonTouchable,
  selectUseButton,
} from './buttons.js';

export interface ServerState {
  /** level.time in seconds (float). Never wall-clock. */
  time: number;
  /**
   * Skill level 0-3 (id `skill` cvar, default 1 = medium). Set via
   * SV_SetSkill (floor + clamp, g_spawn.c). Gates entity inhibit at spawn
   * (SPAWNFLAG_NOT_*), easy-mode damage halving (g_combat.c) and the
   * monster tick's reported damage scale.
   */
  skill: number;
  entities: Edict[];
  movers: Mover[];
  triggers: Trigger[];
  /** scripted movers: func_train + misc_strogg_ship (path_corner chains) */
  trains: Train[];
  /** C-parity secret doors (func_door_secret: back/pause/slide/hold/return). */
  secretDoors: SecretMover[];
  /** C-parity rotating doors (func_door_rotating: angular travel). */
  rotDoors: RotMover[];
  /** monster bodies: every spawned monster_* edict (g_monster.c) */
  monsters: ServerMonster[];
  /** fired targetnames this tick (test/diagnostics hook) */
  firedThisTick: string[];
  /**
   * Pending DelayedUse thinks (game/g_utils.c:173 G_UseTargets delay branch):
   * entities used with a `delay` key fire at level.time + delay, not
   * synchronously. Processed at the head of SV_Tick through fireTargets.
   */
  delayed: ServerDelayedUse[];
  /**
   * Centerprint lines for the driver (game/g_utils.c G_UseTargets message
   * branch: ent->message + misc/talk1.wav for every used entity carrying a
   * message). The driver drains/displays these; help/secret counters are
   * unaffected (their messages latch game state, never centerprint).
   */
  centerprints: string[];
  /**
   * Persistent light-style switch positions (game/g_misc.c light_use:
   * CS_LIGHTS+style flipped between "m" on and "a" off). Keyed by style
   * number (base1 targeted strobes are styles 32-36); the render path
   * consumes this for the lightStyles it submits.
   */
  lightStyles: Record<number, string>;
  /**
   * Style-toggle event log (one entry per light_use firing, in order): the
   * strobe cadence over unattended ticks is observable here.
   */
  lightToggles: ServerLightToggle[];
  /**
   * Persistent areaportal open/closed state by func_areaportal targetname
   * (game/g_func.c door_use_areaportals: doors open/close the portals they
   * target as they travel). Initialized closed at spawn; the PVS consumer
   * follows this record.
   */
  areaPortals: Record<string, boolean>;
  /** per-tick mover displacement by edict num (SV_Push rider carrying) */
  moverDeltas: Map<number, Vec3>;
  /** brush-model bounds by mover edict num (for rider stand tests) */
  moverBounds: Map<number, { mins: Float32Array; maxs: Float32Array }>;
  /**
   * brush-model bounds by trigger edict num. Brush triggers (model *N) have
   * no usable edict origin (it defaults to the world origin 0,0,0), so
   * volume overlap can only be tested when the BSP side supplied bounds via
   * the modelSizes hook. Triggers without bounds never fire from the point
   * hook — firing them by proximity to 0,0,0 is always spurious.
   */
  triggerBounds: Map<number, { mins: Float32Array; maxs: Float32Array }>;
  /**
   * Solid brush-model clips by edict num (func_explosive / func_wall).
   * In C these are SOLID_BSP from spawn until destroyed (SP_func_explosive,
   * SP_func_wall): they block movement while standing. SV_SpawnEntities
   * records their world-space bounds here when modelSizes resolves them;
   * SV_RemoveBrushClip drops the entry when the brush is destroyed
   * (func_explosive_explode / G_FreeEdict). Drivers feed this registry into
   * SV_ClipTrace so walls block before detonation and open after.
   */
  brushClips: Map<number, { mins: Float32Array; maxs: Float32Array }>;
  // --- Phase 0 single sim: server-owned gameplay state --------------------
  //
  // The browser used to run a private driver sim alongside the server tick
  // and rendered only the driver sim, so server fixes never reached the
  // screen (BRAIN.md §15). Phase 0 inverts this: the server owns barrels,
  // bolts, explosions + muzzle/tracer/spark/sound events, debris/gibs and
  // the player health pool. The driver renders from this state and forwards
  // input via SV_PlayerFire. Drained/consumed by the driver every tick;
  // SV_Tick prunes the time-lived ones.
  /** Flying blaster bolts (player + foe edicts: move, wall/flesh touch). */
  bolts: ServerBolt[];
  /** Shootable barrels (misc_explobox bottom-origin + func_explosive center). */
  barrels: ServerBarrel[];
  /** Live explosion visuals (TE_EXPLOSION1/2, TE_BLASTER touch flashes). */
  explosions: ServerExplosion[];
  /** Pending muzzle-flash dlight requests (player + enemy, one-shot). */
  muzzles: ServerMuzzle[];
  /** Pending hitscan tracer beams (short muzzle streaks, never eye-ending). */
  tracers: ServerTracer[];
  /** Pending particle-burst requests (impacts, trails, booms). */
  sparks: ServerSpark[];
  /** Pending positional-sound requests (shots, impacts). */
  sounds: ServerSound[];
  /** Thrown debris chunks (barrel/func_explosive, SV_Physics_Toss-lite). */
  debris: ServerDebris[];
  /** Gib chunks (minced monsters, MOVETYPE_TOSS-lite). */
  gibs: ServerGib[];
  /** Pending 0.2s barrel fuses / target_explosion delays (server time). */
  fuses: ServerFuse[];
  /**
   * Scripted explosion targets (target_explosion, g_target.c
   * use_target_explosion) by targetname. C G_UseTargets fires EVERY edict
   * carrying the name, and base1 stacks up to 4 charges per name (t151:
   * four positions/delays), so this is a list per name, not one record.
   */
  explosionTargets: Map<string, Array<{ origin: Vec3; dmg: number; delay: number }>>;
  /**
   * Ambient spark showers (target_splash, g_target.c use_target_splash) by
   * targetname: TE_SPLASH count/dir/sounds (+dmg radius). Base1 stacks 2 per
   * name (t1), fired on func_timer cadence. No base1 splash carries dmg.
   */
  splashes: Map<string, Array<{ origin: Vec3; count: number; sounds: number; dmg: number; dir: Vec3 }>>;
  /**
   * Positional speakers (target_speaker, g_target.c Use_Target_Speaker) by
   * targetname. One-shot (no loop spawnflags) pushes the noise; looped
   * (spawnflags & 3) toggles a persistent loop-channel entry in st.sounds
   * (start = added, stop = removed); prestarted loops (spawnflags & 1) are
   * seeded at spawn.
   */
  speakers: Map<string, Array<{ origin: Vec3; noise: string; looped: boolean }>>;
  /** Ambient map timers (func_timer, g_func.c func_timer_think). */
  timers: ServerTimer[];
  /**
   * Dedicated ambient-timer jitter stream (C func_timer_think reschedules on
   * wait + crandom spread). Seeded at init — never the global Math.random —
   * so map ambience stays deterministic and no gameplay RNG consumption can
   * shift timer phase (which wedged timer-cadence assertions).
   */
  timerRand: () => number;
  /** Authoritative player health (the driver mirrors it into HUD state). */
  playerHealth: number;
  playerMaxHealth: number;
  /**
   * P_DamageFeedback totals for the driver (game/p_view.c): applied damage
   * since the last drain plus the latest attacker origin (`damage_from`).
   * The server records; the driver drains per tick via
   * SV_DrainPlayerDamage and runs the blend/kick arithmetic. Additive: all
   * previous callers keep working, new ones pass `from` for directional
   * kicks. World damage (drowning/sizzle, C `vec3_origin`) records no
   * direction — C's zero-vector normalize then yields a directionless kick.
   */
  lastPlayerDamage: number;
  lastPlayerDamageFrom: Vec3 | null;
  /**
   * P_WorldEffects drowning state (game/p_view.c): air supply, damage ramp,
   * 1s drown debounce, enter/exit sound latch, lava burn-sound debounce.
   * Ticked in SV_GameTick from the sampled waterlevel; the driver never
   * carries it (predictor runs pmove only).
   */
  playerWorld: WorldEffectsState;
  /**
   * Seconds of air left for the HUD air indicator (P_WorldEffects
   * air_finished - level.time, 12+ when not submerged). The HUD lane owns
   * rendering; this field is the cross-lane value (no HUD files touched).
   */
  playerAirLeft: number;
  /**
   * Timed-suit state (rebreather / envirosuit, game/g_items.c Use_* +
   * p_view.c P_WorldEffects). Until-times are level.time seconds (0 = no
   * effect — C compares breather/enviro_framenum > level.framenum); the
   * Left fields are HUD-exposed seconds remaining (expose only — the HUD
   * lane owns rendering). breathToggle alternates the u_breath pair
   * (C client->breather_sound ^= 1); nextBreathAt schedules it every
   * SUIT_BREATH_PERIOD while submerged+protected; the Warned flags fire
   * the items/airout.wav fade warning once per arming at <=3s remaining.
   */
  playerBreatherUntil: number;
  playerEnviroUntil: number;
  playerBreatherLeft: number;
  playerEnviroLeft: number;
  breathToggle: boolean;
  nextBreathAt: number;
  breatherWarned: boolean;
  enviroWarned: boolean;
  /** Player-trail ring (p_trail.c): pursuit memory when LOS breaks. */
  trail: PlayerTrail;
  /** point_combat firing positions (g_misc.c SP_point_combat). */
  combatPoints: CombatPoint[];
  // --- C level.* intermission counters (g_local.h level_locals_t) --------------
  //
  // Totals are fixed at spawn (skill-inhibited edicts never spawn, like C);
  // found/killed accumulate during play and feed the finished-screen stats
  // (HelpComputer-lite: kills / secrets / goals + level time). The driver
  // renders them; the server owns them (BRAIN.md §15 single-sim).
  /** Every spawned monster edict (C walkmonster_start_go counts all non-good-guy). */
  totalMonsters: number;
  /** Fresh monster death transitions (C Killed(): SVF_MONSTER, not GOOD_GUY). */
  killedMonsters: number;
  /** Spawned target_secret edicts (C SP_target_secret, SP-only). */
  totalSecrets: number;
  /** Single-use secret finds (C use_target_secret + G_FreeEdict). */
  foundSecrets: number;
  /** Spawned target_goal edicts (C SP_target_goal, SP-only). */
  totalGoals: number;
  /** Single-use goal completions (C use_target_goal + G_FreeEdict). */
  foundGoals: number;
  // --- C game.* help-notification state (g_target.c Use_Target_Help) ---------
  //
  // RELEASE-6 server lane (no HUD code here): the server owns ONLY the
  // game-side sequence + message strings. The per-client ack
  // (pers.game_helpchanged / pers.helpchanged / showhelp in C) lives in the
  // driver (SP, in-process — see apps/web PlayBoot.showHelp): on each frame
  // the driver latches `helpSeenSeq = helpChangedSeq; helpChanged = 1` when
  // they differ (G_SetClientSound), beeps via helpBeepDue, flashes the
  // i_help icon via helpIconVisible, and on F1-open zeroes its helpChanged
  // (Cmd_Help_f). The HelpComputer layout itself reads the LIVE
  // killedMonsters/foundGoals/foundSecrets counters above (finish* only
  // freezes the completion screen — SV_FinishLevel semantics unchanged).
  /** C game.helpchanged: bumped by every target_help firing. */
  helpChangedSeq: number;
  /** C game.helpmessage1 (Use_Target_Help, spawnflags & 1). */
  helpMessage1: string;
  /** C game.helpmessage2 (Use_Target_Help, spawnflags & 1 clear). */
  helpMessage2: string;
  /**
   * C level.level_name (worldspawn `message` key, g_spawn.c SpawnEntities):
   * the map title the F1 help computer centers (`HelpComputer`, p_hud.c).
   * Empty when the spawn text carries no worldspawn message (devroom).
   */
  levelName: string;
  /**
   * Server-owned finished state. Set once: 'exit' when a target_changelevel
   * fires (C BeginIntermission-lite for SP — no map change, base2 is not
   * shipped), 'lift' when the one-way end-lift button fires its train (the
   * reachable end-of-game action; the *27 pit exit is sealed rock in every
   * plug state). Stats snapshot freezes here; the sim keeps running (the
   * lift still rides its leg). The driver mirrors this into its message/HUD
   * only — it never decides it.
   */
  finished: boolean;
  /** Which firing path finished the level ('', 'exit', 'lift'). */
  finishReason: '' | 'exit' | 'lift';
  /** level.time at the finish (snapshot for the stats screen). */
  finishTime: number;
  /** Counter snapshots at the finish (post-finish kills don't move the screen). */
  finishKills: number;
  finishSecrets: number;
  finishGoals: number;
  /**
   * Level.time of the last player weapon fire (C client->show_hostile =
   * level.time + 1, g_weapon.c: a recently-hostile player is seen at
   * RANGE_NEAR even from behind, and non-ambush monsters hear the shot).
   * -10 at spawn (nobody hostile yet).
   */
  lastPlayerShotAt: number;
  /**
   * RELEASE-4 boarding guard (driver-owned pmove ground, server-checked
   * finish): the driver's current `pm.groundEntity` (-1 world/none, else
   * the stood-upon mover/train clip num, linked by pmove's ground trace).
   * Set by the driver every tick before SV_Tick and before E-use (the
   * server never moves the player body itself). The 'lift' finish
   * (wait -1 button + train start) requires this to be the exit train's
   * edict num — boarding alone never finishes, pressing/shooting the call
   * button from outside starts the train (C-correct, secret found) but does
   * NOT finish. Default -1 (never aboard).
   */
  playerGroundEntity: number;
}

export function SV_Init(): ServerState {
  return { time: 0, skill: 1, entities: [], movers: [], trains: [], secretDoors: [], rotDoors: [], monsters: [], triggers: [] as Trigger[], firedThisTick: [], delayed: [], centerprints: [], lightStyles: {}, lightToggles: [], areaPortals: {}, moverDeltas: new Map(), moverBounds: new Map(), triggerBounds: new Map(), brushClips: new Map(), bolts: [], barrels: [], explosions: [], muzzles: [], tracers: [], sparks: [], sounds: [], debris: [], gibs: [], fuses: [], explosionTargets: new Map(), splashes: new Map(), speakers: new Map(), timers: [], timerRand: mulberry32(0x71E4), playerHealth: 100, playerMaxHealth: 100, playerWorld: makeWorldEffectsState(), playerAirLeft: AIR_GRACE, playerBreatherUntil: 0, playerEnviroUntil: 0, playerBreatherLeft: 0, playerEnviroLeft: 0, breathToggle: false, nextBreathAt: 0, breatherWarned: false, enviroWarned: false, trail: trailInit(false), combatPoints: [], totalMonsters: 0, killedMonsters: 0, totalSecrets: 0, foundSecrets: 0, totalGoals: 0, foundGoals: 0, helpChangedSeq: 0, helpMessage1: '', helpMessage2: '', levelName: '', finished: false, finishReason: '', finishTime: 0, finishKills: 0, finishSecrets: 0, finishGoals: 0, lastPlayerShotAt: -10, lastPlayerDamage: 0, lastPlayerDamageFrom: null, playerGroundEntity: -1 };
}

/**
 * RELEASE-4: latch the driver's current ground entity for the aboard guard
 * (see ServerState.playerGroundEntity). Call every tick before SV_Tick and
 * before E-use; the server never sets this itself.
 */
export function SV_SetPlayerGround(st: ServerState, groundEntity: number): void {
  st.playerGroundEntity = groundEntity;
}

/**
 * Mark the level finished (server-owned; the driver renders only). First
 * reason wins; the counter snapshot freezes here so the stats screen never
 * moves under post-finish play.
 */
export function SV_FinishLevel(st: ServerState, reason: 'exit' | 'lift'): void {
  if (st.finished) return;
  st.finished = true;
  st.finishReason = reason;
  st.finishTime = st.time;
  st.finishKills = st.killedMonsters;
  st.finishSecrets = st.foundSecrets;
  st.finishGoals = st.foundGoals;
}

/** Clear the finished state (respawn path: a new life re-opens the level). */
export function SV_ClearFinished(st: ServerState): void {
  st.finished = false;
  st.finishReason = '';
  st.finishTime = 0;
  st.finishKills = 0;
  st.finishSecrets = 0;
  st.finishGoals = 0;
}

/**
 * C G_SetStats help-icon flash (game/p_hud.c): STAT_HELPICON is `i_help`
 * iff the client still has an unacknowledged change AND (level.framenum&8).
 * `helpChanged` is the driver-side pers.helpchanged counter (1..4 unacked,
 * 0 acked on F1-open); `framenum` is the 10Hz frame (web lane derives it
 * as floor(serverTime * 10)). Pure — no HUD code, the web lane consumes it.
 */
export function helpIconVisible(helpChanged: number, framenum: number): boolean {
  return helpChanged !== 0 && (framenum & 8) !== 0;
}

/**
 * C G_SetClientSound help beep (game/p_view.c): while the unacknowledged
 * counter is 1..3, beep once every 64th frame (`misc/pc_up.wav`); the caller
 * then increments its counter (pers.helpchanged++), so the beep stops after
 * three plays. Pure — the driver owns the counter and the sound request.
 */
export function helpBeepDue(helpChanged: number, framenum: number): boolean {
  return helpChanged !== 0 && helpChanged <= 3 && (framenum & 63) === 0;
}

/** Link an edict into the world (SV_LinkEdict: register + solid bookkeeping). */
export function SV_LinkEdict(st: ServerState, e: Edict): void {
  if (!st.entities.includes(e)) st.entities.push(e);
}

// --- skill (game/g_spawn.c, game/g_combat.c) ---------------------------------
//
// The id `skill` cvar (0 easy, 1 medium, 2 hard, 3 nightmare; default 1).
// Concrete game effects, ported verbatim where they touch the server:
// - Spawn inhibit (g_spawn.c SpawnEntities): entities carrying
//   SPAWNFLAG_NOT_EASY/MEDIUM/HARD never spawn at the matching skill. This is
//   why base1's 1792-flagged ammo caches and the exit machinegun are
//   deathmatch-only, and why two ambush infantries appear only at skill 2+.
// - Easy damage halving (g_combat.c T_Damage): skill 0 halves damage dealt
//   to the player (minimum 1, applied driver-side).
// NOT flags are stripped from spawned edicts after the check, exactly like C.

export const SPAWNFLAG_NOT_EASY = 256;
export const SPAWNFLAG_NOT_MEDIUM = 512;
export const SPAWNFLAG_NOT_HARD = 1024;
export const SPAWNFLAG_NOT_DEATHMATCH = 2048;
/** id g_local.h: Touch_Item fired the item's targets (set on first take). */
export const ITEM_TARGETS_USED = 0x00040000;
export const SPAWNFLAG_NOT_COOP = 4096;

/**
 * func_door spawnflag: monsters never trip this door (id g_func.c
 * Touch_DoorTrigger). Local copy — @q2/game owns the mover sim and only
 * re-exports DOOR_START_OPEN/DOOR_TOGGLE; like the SPAWNFLAG_* bits above,
 * the server keeps its own copy for spawn/touch gating (same value, C-cited).
 */
export const DOOR_NOMONSTER = 8;

/** True when the entity is inhibited at `skill` (g_spawn.c SpawnEntities). */
export function inhibitedBySkill(spawnflags: number, skill: number): boolean {
  if (skill === 0 && spawnflags & SPAWNFLAG_NOT_EASY) return true;
  if (skill === 1 && spawnflags & SPAWNFLAG_NOT_MEDIUM) return true;
  if ((skill === 2 || skill === 3) && spawnflags & SPAWNFLAG_NOT_HARD) return true;
  return false;
}

/**
 * True when the entity never spawns in SP at any skill (g_spawn.c: the
 * 1792-flagged exit machinegun + ammo caches carry NOT_EASY|NOT_MEDIUM|
 * NOT_HARD, so every SP skill inhibits them; deathmatch spawns them since
 * the DM branch only checks NOT_DEATHMATCH). Web-lane helper (do not
 * duplicate the table in apps/web): filter SP pickups through this instead
 * of reimplementing skill gating.
 */
export function dmOnlyInSP(spawnflags: number): boolean {
  return (
    inhibitedBySkill(spawnflags, 0) &&
    inhibitedBySkill(spawnflags, 1) &&
    inhibitedBySkill(spawnflags, 2) &&
    inhibitedBySkill(spawnflags, 3)
  );
}

/**
 * Damage dealt TO the player scales by this (g_combat.c: easy halves it).
 * Health is not skill-scaled in id (only damage, pain, aim and the roster).
 *
 * Nightmare note (verified, not assumed): NOTHING in C scales damage at
 * skill 3 — g_combat.c halves only at skill 0, and the skill-3 branches
 * (pain debounce in T_Damage, duck/dodge/re-attack odds in m_soldier.c,
 * m_gunner.c, m_infantry.c) are all behavioral. The old "nightmare x2"
 * guess was wrong; the shape stays {0: 0.5, else 1}.
 */
export function skillMultiplier(skill: number): number {
  return skill <= 0 ? 0.5 : 1;
}

/**
 * Set the skill level (id skill cvar: floor + clamp to 0-3, g_spawn.c).
 * Returns the applied level.
 */
export function SV_SetSkill(st: ServerState, skill: number): number {
  let s = Math.floor(skill);
  if (!Number.isFinite(s)) s = 1;
  if (s < 0) s = 0;
  if (s > 3) s = 3;
  st.skill = s;
  return s;
}

// --- C-authentic contents masks (game/q_shared.h) --------------------------
//
// The game-side default (MASK_PLAYERSOLID = 1 in @q2/game/collision.ts) only
// tests CONTENTS_SOLID. The C engine collides the player against
// MASK_PLAYERSOLID = SOLID|PLAYERCLIP|WINDOW|MONSTER and walks monsters with
// MASK_MONSTERSOLID = SOLID|MONSTERCLIP|WINDOW|MONSTER; sight checks run eye
// to eye against MASK_OPAQUE = SOLID|SLIME|LAVA. Base1 seals stairs and
// ledges with PLAYERCLIP detail brushes (36 in this map) and glass with
// WINDOW (7): a mask-1 trace falls straight through those floors, including
// spots where the player box exits the world volume entirely (the reported
// clip-through/void). traceBox itself is mask-correct — only the mask handed
// in was wrong — so these server-owned helpers hand in the C masks.

export const CONTENTS_SOLID = 1;
export const CONTENTS_WINDOW = 2;
export const CONTENTS_SLIME = 16;
export const CONTENTS_LAVA = 8;
export const CONTENTS_PLAYERCLIP = 0x10000;
export const CONTENTS_MONSTERCLIP = 0x20000;
export const CONTENTS_MONSTER = 0x2000000;

/** C MASK_PLAYERSOLID (SOLID|PLAYERCLIP|WINDOW|MONSTER, q_shared.h). */
export const MASK_PLAYERSOLID_C =
  CONTENTS_SOLID | CONTENTS_WINDOW | CONTENTS_PLAYERCLIP | CONTENTS_MONSTER;
/** C MASK_MONSTERSOLID (SOLID|MONSTERCLIP|WINDOW|MONSTER, q_shared.h). */
export const MASK_MONSTERSOLID_C =
  CONTENTS_SOLID | CONTENTS_WINDOW | CONTENTS_MONSTERCLIP | CONTENTS_MONSTER;
/** C MASK_OPAQUE (SOLID|SLIME|LAVA: the visible() sight mask, g_ai.c). */
export const MASK_OPAQUE_C = CONTENTS_SOLID | CONTENTS_SLIME | CONTENTS_LAVA;

/** Monster eye height above origin (walkmonster_start_go, g_monster.c). */
export const MONSTER_VIEWHEIGHT = 25;
/** Standing player eye height (pmove_t.viewheight default, pmove.c). */
export const PLAYER_VIEWHEIGHT = 22;

/** Swept-box world trace with the C player mask (CM_BoxTrace, model 0). */
export function SV_TraceFor(map: BspMap, mask: number = MASK_PLAYERSOLID_C): TraceFn {
  return (start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) => {
    const t = traceBox(map, start, end, mins, maxs, mask);
    return {
      fraction: t.fraction,
      endpos: t.endpos,
      planeNormal: t.planeNormal,
      allsolid: t.allsolid,
      startsolid: t.startsolid,
      entityNum: t.entityNum,
      contents: t.contents,
      surfaceFlags: t.surfaceFlags,
    };
  };
}

/**
 * C M_droptofloor grounding trace (game/g_monster.c): id drops walkmonsters
 * AND exploboxes with `gi.trace(..., MASK_MONSTERSOLID)` — never the player
 * mask and never mask 1. A mask-1 trace misses clip-sealed decks (base1's
 * start-room soldier at (348,-348,-64) falls to -86.27, below the true
 * -83.97 floor both C masks hit) so spawn grounding must run through this,
 * not through a generic world trace. Pass it as SV_SpawnEntities' dropTrace.
 */
export function SV_DropTraceFor(map: BspMap): TraceFn {
  return SV_TraceFor(map, MASK_MONSTERSOLID_C);
}

/**
 * Install C-mask world hooks for pmove. Same shape as the game-side
 * setPmoveWorldFromBsp but with MASK_PLAYERSOLID_C, so clip-deck floors and
 * stairs the mapper sealed with PLAYERCLIP/WINDOW hold the player the way
 * the C engine holds them.
 *
 * The contents hook carries the SOLID bit (bspPointContentsFor): the
 * pmove waterjump wall probe (`& CONTENTS_SOLID`) and the server-side
 * P_WorldEffects sampler read through it. Dry-land consumers only test
 * MASK_WATER, so dry-land traces are bit-identical to the legacy hook.
 */
export function SV_SetPmoveWorldFromBsp(map: BspMap): void {
  const contents = bspPointContentsFor(map);
  SV_WorldContents = contents;
  // Pmove-only contents mapping (game withPmoveContents): the C-mask trace
  // reports raw BSP bits (LADDER 0x20000000) that the pmove ladder probe
  // cannot read unmapped. SV_TraceFor itself stays raw for weapon/effect
  // consumers (hitscan water checks key on WATER 32).
  setPmoveWorld(withPmoveContents(SV_TraceFor(map)), contents);
}

/**
 * Solid-aware point contents installed by SV_SetPmoveWorldFromBsp (null
 * before any map is wired: devroom/asset-free paths skip world effects).
 * The server-side P_WorldEffects sampler reads through this; the driver
 * installs it at boot, so no driver call-site changes are needed.
 */
export let SV_WorldContents: PointContentsFn | null = null;

export function SV_SpawnMover(st: ServerState, m: Mover): void {
  SV_LinkEdict(st, m.ent);
  st.movers.push(m);
}

export function SV_SpawnTrigger(st: ServerState, t: Trigger, bounds?: { mins: Float32Array; maxs: Float32Array }): void {
  SV_LinkEdict(st, t.ent);
  st.triggers.push(t);
  if (bounds) st.triggerBounds.set(t.ent.num, bounds);
}

/**
 * Drop a brush clip when its brush is destroyed (func_explosive_explode with
 * or without dmg — BecomeExplosion1 frees the edict either way; G_FreeEdict
 * for damageless ones — and G_FreeEdict for func_wall). The opening stays
 * open; whatever world floor the mapper left beneath catches the fall.
 */
export function SV_RemoveBrushClip(st: ServerState, ent: Edict): void {
  st.brushClips.delete(ent.num);
}

/**
 * Swept player/monster box vs one static brush AABB. Ports qcommon/cmodel.c
 * CM_ClipBoxToBrush: starting inside only stops the move when the end is
 * inside too (leaving counts as fraction 1), and the enter/leave fractions
 * carry the C DIST_EPSILON (1/32) bias so contact stops a hair short — a
 * landing never rests exactly on the plane. Without the bias a body
 * standing exactly on a clip top reads allsolid on every overlapping sweep
 * and glues in place (C landings always rest +1/32, so the exact state is
 * unreachable there). The boundary-inclusive inside test matches C's
 * d1 == 0 counts-as-inside position rule.
 */
export function sweepBrushBox(
  start: Vec3, end: Vec3,
  mins: Vec3, maxs: Vec3,
  bmins: Float32Array, bmaxs: Float32Array,
): { fraction: number; normal: Vec3; allsolid: boolean; startsolid: boolean } {
  const lo = [bmins[0]! - maxs[0]!, bmins[1]! - maxs[1]!, bmins[2]! - maxs[2]!];
  const hi = [bmaxs[0]! - mins[0]!, bmaxs[1]! - mins[1]!, bmaxs[2]! - mins[2]!];
  const inside = (p: Vec3): boolean =>
    p[0]! >= lo[0]! && p[0]! <= hi[0]! &&
    p[1]! >= lo[1]! && p[1]! <= hi[1]! &&
    p[2]! >= lo[2]! && p[2]! <= hi[2]!;
  if (inside(start)) {
    if (inside(end)) {
      const n = v3(0, 0, 0);
      const pens = [
        Math.min(start[0]! - lo[0]!, hi[0]! - start[0]!),
        Math.min(start[1]! - lo[1]!, hi[1]! - start[1]!),
        Math.min(start[2]! - lo[2]!, hi[2]! - start[2]!),
      ];
      let axis = 0;
      if (pens[1]! < pens[axis]!) axis = 1;
      if (pens[2]! < pens[axis]!) axis = 2;
      const mid = (lo[axis]! + hi[axis]!) / 2;
      n[axis] = start[axis]! < mid ? -1 : 1;
      return { fraction: 0, normal: n, allsolid: true, startsolid: true };
    }
    return { fraction: 1, normal: v3(0, 0, 1), allsolid: false, startsolid: true };
  }
  // Slab sweep (qcommon/cmodel.c CM_ClipBoxToBrush, axial case): enterfrac
  // starts at -1 so a contact entry (biased fraction <= 0) still records
  // the hit axis and clamps to fraction 0 (grounded). Per C, starting
  // outside a slab and moving away (or parallel) can never enter — "if
  // completely in front of face, no intersection" (d1 > 0 && d2 >= d1) —
  // so the whole sweep misses right away. Without this a clip sitting
  // behind the walk direction reports a fraction-0 phantom block (with a
  // spurious startsolid) that SV_ClipTrace prefers over the real world
  // hit — an invisible obstruction that freezes walking near the exit
  // complex, where the *31/*32/*33/*34/train clips share the body's y/z
  // band. startsolid is false throughout: C sets it only when the start
  // is inside (our inside() branch above), never from an entry fraction.
  let tmin = -1, tmax = 1, axis = -1, sign = 0;
  for (let i = 0; i < 3; i++) {
    const d = end[i]! - start[i]!;
    if (Math.abs(d) < 1e-9) {
      if (start[i]! < lo[i]! || start[i]! > hi[i]!) {
        return { fraction: 1, normal: v3(0, 0, 1), allsolid: false, startsolid: false };
      }
      continue;
    }
    if ((start[i]! < lo[i]! && d < 0) || (start[i]! > hi[i]! && d > 0)) {
      return { fraction: 1, normal: v3(0, 0, 1), allsolid: false, startsolid: false };
    }
    let t1 = (lo[i]! - start[i]!) / d;
    let t2 = (hi[i]! - start[i]!) / d;
    let s = -1;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
      s = 1;
    }
    // C enter/leave bias: f = (d1 -+ DIST_EPSILON) / (d1 - d2), i.e. the
    // slab entry shifts earlier by eps/|d| and the exit later by eps/|d|.
    // The startsolid flag stays on the unbiased entry (C sets it from the
    // strict inside test, not from the biased fraction).
    const bias = DIST_EPSILON / Math.abs(d);
    const t1b = t1 - bias;
    const t2b = t2 + bias;
    if (t1b > tmin) {
      tmin = t1b;
      axis = i;
      sign = s;
    }
    if (t2b < tmax) tmax = t2b;
    if (tmin > tmax) return { fraction: 1, normal: v3(0, 0, 1), allsolid: false, startsolid: false };
  }
  if (axis < 0) return { fraction: 1, normal: v3(0, 0, 1), allsolid: false, startsolid: false };
  const n = v3(0, 0, 0);
  n[axis] = sign;
  return { fraction: Math.max(0, Math.min(1, tmin)), normal: n, allsolid: false, startsolid: false };
}

/**
 * Current world-space clip box of a slider/button mover: the rest brush
 * bounds shifted by the travelled offset (ent.origin - pos1). C links every
 * SOLID_BSP mover brush, so standing, shots and sight all collide with the
 * slab where it IS, not where it rested (the parked-lift fall-through was
 * the mover missing from this trace entirely).
 */
export function SV_MoverClipBox(
  st: ServerState,
  m: Mover,
): { mins: Float32Array; maxs: Float32Array } | null {
  const b = st.moverBounds.get(m.ent.num);
  if (!b || m.ent.freed) return null;
  const dx = m.ent.origin[0]! - m.pos1[0]!;
  const dy = m.ent.origin[1]! - m.pos1[1]!;
  const dz = m.ent.origin[2]! - m.pos1[2]!;
  if (dx === 0 && dy === 0 && dz === 0) return b;
  return {
    mins: new Float32Array([b.mins[0]! + dx, b.mins[1]! + dy, b.mins[2]! + dz]),
    maxs: new Float32Array([b.maxs[0]! + dx, b.maxs[1]! + dy, b.maxs[2]! + dz]),
  };
}

/**
 * Current world-space clip box of a brush func_train: the rest brush bounds
 * shifted by the train origin (brush-model origins are 0 in base1, so rest
 * is the mapper bounds and the live offset is ent.origin itself). Point
 * ships (misc_strogg_ship) have no brush and never clip.
 */
export function SV_TrainClipBox(
  st: ServerState,
  tr: Train,
): { mins: Float32Array; maxs: Float32Array } | null {
  if (tr.ship) return null;
  const b = st.moverBounds.get(tr.ent.num);
  if (!b || tr.ent.freed) return null;
  const dx = tr.ent.origin[0]!;
  const dy = tr.ent.origin[1]!;
  const dz = tr.ent.origin[2]!;
  if (dx === 0 && dy === 0 && dz === 0) return b;
  return {
    mins: new Float32Array([b.mins[0]! + dx, b.mins[1]! + dy, b.mins[2]! + dz]),
    maxs: new Float32Array([b.maxs[0]! + dx, b.maxs[1]! + dy, b.maxs[2]! + dz]),
  };
}

/**
 * Current world-space clip box of a live monster: the C SOLID_BBOX hull
 * (MONSTER_HULL_MINS + duck-aware maxs) at the edict origin. Null for every
 * body movement must pass through: dormant TRIGGER_SPAWN (SOLID_NOT until
 * monster_triggered_spawn), gibbed (G_FreeEdict-gone in C), and settled
 * corpses (C Killed→die→death-move endfunc sets SVF_DEADMONSTER, which
 * SV_ClipMoveToEntities skips unless the mask carries CONTENTS_DEADMONSTER
 * — corpses never block the living). Dying bodies (dead, death move still
 * playing, C deadflag DEAD_DEAD but no SVF_DEADMONSTER yet) DO clip: the
 * fall blocks until the endfunc lands. Corpses stay hittable through the
 * state-based bolt/pellet sweeps, which key off state.dead instead of solid.
 */
export function SV_MonsterClipBox(
  m: ServerMonster,
): { mins: Float32Array; maxs: Float32Array } | null {
  if (m.edict.freed || m.edict.solid !== SOLID_BBOX) return null;
  if (m.kind === null || m.state.deadDone || m.state.gibbed) return null;
  if (m.triggered && !m.woken) return null;
  const maxs = monsterHullMaxs(m);
  return {
    mins: new Float32Array([
      m.edict.origin[0]! + MONSTER_HULL_MINS[0]!,
      m.edict.origin[1]! + MONSTER_HULL_MINS[1]!,
      m.edict.origin[2]! + MONSTER_HULL_MINS[2]!,
    ]),
    maxs: new Float32Array([
      m.edict.origin[0]! + maxs[0]!,
      m.edict.origin[1]! + maxs[1]!,
      m.edict.origin[2]! + maxs[2]!,
    ]),
  };
}

/**
 * World trace plus the solid brush clips (func_explosive / func_wall while
 * standing). Drivers that move bodies (pmove, monster locomotion) should run
 * against this instead of the bare world trace so walls block until
 * SV_RemoveBrushClip opens them.
 *
 * C trace.ent for SOLID_BSP (g_phys.c SV_ClipMoveToEntities): the clip that
 * stops the move owns the hit, so its edict num is reported as entityNum
 * (traceBox itself always reports 0 = world). Bolt/pellet/radius code uses
 * this to resolve touches against the brush edict itself (func_explosive
 * takes direct fire, not just splash) instead of detonating on an anonymous
 * wall. Movement consumers ignore entityNum (fraction/endpos/normal only),
 * except pmove's groundEntity which simply records the stood-upon clip.
 *
 * Live monsters ride an OPT-IN pass (C SV_ClipMoveToEntities clips
 * SOLID_BBOX bodies, MASK_MONSTERSOLID walkers included): a player-size box
 * sweeping through a live infantry stops on its hull and reports the edict
 * num, so bodies can no longer be walked through. `ignoreNum` is the C
 * passedict skip (a monster stepping itself must not clip its own hull);
 * the player is never a monster edict, so pmove callers leave it default.
 *
 * The monster pass defaults OFF (includeMonsters: false): callers that
 * feed one shared trace to both pmove and the monster tick would freeze
 * every mover inside its own hull (a mover always starts inside it) unless
 * they pass the mover's own edict as ignoreNum. SV_MonsterTick does that
 * per monster internally (moveTraceFor), so the tick is freeze-free on a
 * shared trace; pmove-only callers pass includeMonsters + leave ignoreNum
 * at the player (never a monster num, so no self-skip needed there).
 */
export function SV_ClipTrace(
  st: ServerState,
  worldTrace: TraceFn,
  ignoreNum = -1,
  includeMonsters = false,
): TraceFn {
  return (start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) => {
    let best = worldTrace(start, mins, maxs, end);
    let clipEnt = -1;
    // One shared nearest-wins pass over every SOLID_BSP clip: static brush
    // clips first, then the live mover/train boxes (doors/buttons/plats at
    // their travelled offset, brush trains at their corner offset). Like C
    // (SV_ClipMoveToEntities), the clip that stops the move owns the hit, so
    // pmove's groundEntity links riders to the pusher they stand on
    // (groundentity == pusher rides in SV_Push).
    const consider = (num: number, b: { mins: Float32Array; maxs: Float32Array } | null): void => {
      if (!b || num === ignoreNum) return;
      if (!b) return;
      const hit = sweepBrushBox(start, end, mins, maxs, b.mins, b.maxs);
      if (hit.fraction < best.fraction || hit.allsolid) {
        const f = hit.fraction;
        best = {
          fraction: f,
          endpos: v3(
            start[0]! + (end[0]! - start[0]!) * f,
            start[1]! + (end[1]! - start[1]!) * f,
            start[2]! + (end[2]! - start[2]!) * f,
          ),
          planeNormal: hit.normal,
          allsolid: hit.allsolid,
          startsolid: hit.startsolid,
          entityNum: best.entityNum,
          contents: best.contents,
          surfaceFlags: best.surfaceFlags,
        };
        clipEnt = num;
      }
    };
    for (const [num, b] of st.brushClips) consider(num, b);
    for (const m of st.movers) {
      if (m.ent.classname !== 'func_door' && m.ent.classname !== 'func_button' && m.ent.classname !== 'func_plat') continue;
      consider(m.ent.num, SV_MoverClipBox(st, m));
    }
    for (const tr of st.trains) consider(tr.ent.num, SV_TrainClipBox(st, tr));
    // Opt-in monster hulls (see the doc comment: on by default this freezes
    // every mover inside its own hull, including via the shared driver
    // trace). Pmove-only callers pass includeMonsters + leave ignoreNum at
    // the player (never a monster num, so no self-skip needed there).
    if (includeMonsters) {
      for (const m of st.monsters) consider(m.edict.num, SV_MonsterClipBox(m));
    }
    if (clipEnt >= 0) best.entityNum = clipEnt;
    return best;
  };
}

// --- drop to floor (game/g_monster.c M_droptofloor) ---------------------------
//
// Barrels (SP_misc_explobox think) and walkmonsters (walkmonster_start_go,
// when not triggered and level.time < 1) snap to the floor at spawn: origin
// nudged +1 up, traced 256 down with the entity hull under MASK_MONSTERSOLID
// (see SV_DropTraceFor — a narrower mask falls through clip decks to a lower
// level); a clean miss or an allsolid start keeps the mapper origin. The
// trace hook is supplied by the caller (SV_DropTraceFor in tests); without
// it origins are kept as mapped.

export function droptofloor(origin: Vec3, mins: Vec3, maxs: Vec3, trace: TraceFn): Vec3 {
  const start = v3(origin[0], origin[1], origin[2]! + 1);
  const end = v3(origin[0], origin[1], origin[2]! - 256);
  const t = trace(start, mins, maxs, end);
  if (t.fraction === 1 || t.allsolid) return v3(origin[0], origin[1], origin[2]);
  return v3(t.endpos[0], t.endpos[1], t.endpos[2]);
}

/**
 * id G_SetMovedir (g_utils.c) for target_splash: the scalar `angle` key maps
 * to yaw (pitch 0), except -1 (VEC_UP (0,-1,0)) and -2 (VEC_DOWN (0,-2,0))
 * which spray straight up/down; the vector `angles` key is used verbatim
 * with the same two special cases. Base1 splashes all use scalar angles
 * (-2 down, 90, 180).
 */
export function splashMovedir(dict: Record<string, string>): Vec3 {
  let angles: Vec3;
  if (dict['angles'] !== undefined) {
    angles = parseVec3(dict['angles'], v3());
  } else {
    angles = v3(0, parseFloat(dict['angle'] ?? '', 0), 0);
  }
  if (angles[0] === 0 && angles[1] === -1 && angles[2] === 0) return v3(0, 0, 1);
  if (angles[0] === 0 && angles[1] === -2 && angles[2] === 0) return v3(0, 0, -1);
  const fwd = v3();
  const right = v3();
  const up = v3();
  AngleVectors(angles, fwd, right, up);
  return fwd;
}

// --- monsters (game/g_monster.c walkmonster_start) ---------------------------

export interface ServerMonster {
  edict: Edict;
  state: MonsterState;
  /** soldier | gunner | infantry (unmapped kinds stay present but dormant). */
  kind: MonsterKind | null;
  /** spawnflags & 1: ambush — holds position until it sees the player. */
  ambush: boolean;
  /** spawnflags & 2: triggered — dormant until used (monster_triggered_start). */
  triggered: boolean;
  /** monster_triggered_spawn ran (solid, visible, thinking). */
  woken: boolean;
  /** latched the first tick with line of sight (ambush acquire). */
  seen: boolean;
  // --- M5.3 depth: per-monster pursuit/duck/combat-point state ---------------
  // (C monsterinfo fields the lite sim never carried). reactionAt is the
  // sight-delay gate (HuntTarget AttackFinished, skill-scaled): no attack
  // may start before it. 0 = already alert (synthetics); -1 = stamp on the
  // next tick (woken bodies whose use carried no clock).
  /** Earliest attack start after acquiring the enemy (0 ready, -1 stamp). */
  reactionAt: number;
  /** Duck-hold expiry (m_soldier.c pausetime; 0 = not ducking). */
  duckUntil: number;
  /** attack3: fire once mid-duck (m_soldier.c duck-and-shoot). */
  duckShoot: boolean;
  /** Sustained-fire hold expiry (C monsterinfo.pausetime for the gun:
   * m_soldier.c soldier_fire4 / m_infantry.c infantry_cock_gun; 0 = no
   * hold). While now < burstUntil the fire frame freezes and re-fires
   * every 10Hz tick (C AI_HOLD_FRAME in M_MoveFrame). */
  burstUntil: number;
  /** Sustained-fire hold flag (C AI_HOLD_FRAME itself): set while the
   * fire frame is frozen, cleared by the thinkfunc once the pausetime
   * lapses (firing once more that tick — the C expiry bullet). Exists
   * because the pausetime alone cannot tell a fresh arrival (arm) from
   * the expiry replay (advance without re-arming). */
  burstHeld: boolean;
  /** Combat-point destination (AI_COMBAT_POINT en route; null = hunting). */
  combatGoal: Vec3 | null;
  /** point_combat hold flag: stand ground after arrival. */
  combatHold: boolean;
  /** FoundTarget combattarget hookup already ran (one-shot). */
  combatDone: boolean;
  /**
   * Wall-following chirality for the SV_NewChaseDir-lite heading sweep
   * (+1 = try goal-left first, -1 = goal-right first, 0 = undecided).
   * Committed from the sweep's feedback each tick and dropped when the
   * direct leg clears or sight is regained, so a body sliding along a face
   * keeps its hand instead of dithering back.
   */
  slideDir: number;
  /**
   * Patrol beat (g_monster.c movetarget / g_misc.c path_corner): targetname
   * of the corner currently being walked to ('' = no beat — stand until
   * seen). Set at spawn for target→path_corner monsters (and at wake for
   * triggered ones); walked while unseen, abandoned on acquire (seen hunts
   * from then on). Chained by targetname on arrival so loops run forever.
   */
  patrolCorner: string;
  /** World position of patrolCorner (re-resolved on every advance). */
  patrolGoal: Vec3 | null;
  /** Corner-wait hold: stand until this level.time (C pausetime on wait). */
  patrolWaitUntil: number;
}

/**
 * Map a monster classname onto the lite defs. monster_soldier_light is a
 * soldier with a different skin (SP_monster_soldier_light); infantry maps
 * onto the INFANTRY lite def (@q2/game monsters.ts).
 */
export function monsterKindOf(classname: string): MonsterKind | null {
  if (classname === 'monster_soldier' || classname === 'monster_soldier_light') return 'soldier';
  if (classname === 'monster_soldier_ss') return 'soldier';
  if (classname === 'monster_gunner') return 'gunner';
  if (classname === 'monster_infantry') return 'infantry';
  return null;
}

// --- trains + ships (game/g_func.c func_train, game/g_misc.c ships) ----------
//
// func_train and misc_strogg_ship both ride path_corner chains (train_next):
// the body origin tracks `corner - base`, where base is the brush-model mins
// for trains and the (-16,-16,0) ship hull for point ships. Teleport corners
// (spawnflags & 1) snap the origin instead of travelling. Ships start hidden
// (SVF_NOCLIENT) and trains dormant while they carry a targetname; a use
// (misc_strogg_ship_use / train_use, e.g. trigger_always at level start or
// the *13 button for the exit train) starts them. Bodies with no remaining
// target stop on the final corner.

export interface TrainCorner {
  pos: Vec3;
  wait: number;
  teleport: boolean;
  pathtarget: string;
  /**
   * Targetname of this corner (the key other corners / the train link by).
   * Needed for C-faithful chaining: id train_next advances via
   * self->target = ent->target (G_PickTarget), so a corner whose target
   * names an earlier corner wraps the loop forever instead of ending it.
   */
  name: string;
  /** Target link this corner hands off to on arrival (ent->target). */
  target: string;
}

export interface Train {
  ent: Edict;
  /** true for misc_strogg_ship (point hull), false for func_train (brush). */
  ship: boolean;
  /** mins reference subtracted from corner positions (g_func.c dest math). */
  base: Vec3;
  corners: TrainCorner[];
  /** index of the corner currently being travelled to */
  seg: number;
  from: Vec3;
  to: Vec3;
  /** level.time at which a wait ends, or -1 when travelling/stopped */
  waitUntil: number;
  started: boolean;
  arrived: boolean;
  speed: number;
  /** spawnflags TRAIN_TOGGLE (game/g_func.c): use pauses mid-leg / resumes. */
  toggle: boolean;
  /** TOGGLE halt (mid-leg stop or wait<0 corner hold); use resumes. */
  halted: boolean;
  /** blocked damage (SP_func_train: 100, or 0 with BLOCK_STOPS). */
  dmg: number;
  /** debounce for train_blocked damage. */
  touchDebounce: number;
}

/** Ship hull from SP_misc_strogg_ship (VectorSet mins -16,-16,0). */
const SHIP_BASE: Vec3 = v3(-16, -16, 0);

/** Resolve the path_corner chain starting at `target` (G_PickTarget: first match). */
function resolveCorners(edicts: Edict[], target: string): TrainCorner[] {
  const corners: TrainCorner[] = [];
  const seen = new Set<string>();
  let t = target;
  for (let i = 0; i < 64 && t && !seen.has(t); i++) {
    seen.add(t);
    const c = edicts.find((e) => !e.freed && e.targetname === t && e.classname === 'path_corner');
    if (!c) break;
    corners.push({
      pos: v3(c.origin[0], c.origin[1], c.origin[2]),
      wait: c.wait,
      teleport: (c.spawnflags & 1) !== 0,
      pathtarget: c.extra['pathtarget'] ?? '',
      name: t,
      target: c.target,
    });
    t = c.target;
  }
  return corners;
}

/** Place a train/ship on its first corner (func_train_find). */
function placeTrain(tr: Train): void {
  const first = tr.corners[0];
  if (!first) return;
  tr.ent.origin[0] = first.pos[0]! - tr.base[0]!;
  tr.ent.origin[1] = first.pos[1]! - tr.base[1]!;
  tr.ent.origin[2] = first.pos[2]! - tr.base[2]!;
}

/** Begin (or resume) travel toward corners[seg] (train_next). */
function trainNext(tr: Train, now: number): void {
  for (let guard = 0; guard < tr.corners.length + 1; guard++) {
    const dest = tr.corners[tr.seg];
    if (!dest) {
      tr.arrived = true;
      tr.waitUntil = -1;
      return;
    }
    if (dest.teleport) {
      // Teleport corner (id `goto again`): snap without a travel leg, then
      // keep chaining from the teleport's own target link. A cycle made only
      // of teleports exhausts the guard and stops, like C's connected-
      // teleport error return.
      tr.ent.origin[0] = dest.pos[0]! - tr.base[0]!;
      tr.ent.origin[1] = dest.pos[1]! - tr.base[1]!;
      tr.ent.origin[2] = dest.pos[2]! - tr.base[2]!;
      if (!advanceTrainSeg(tr)) return;
      continue;
    }
    tr.from = v3(tr.ent.origin[0], tr.ent.origin[1], tr.ent.origin[2]);
    tr.to = v3(dest.pos[0]! - tr.base[0]!, dest.pos[1]! - tr.base[1]!, dest.pos[2]! - tr.base[2]!);
    tr.waitUntil = -1;
    return;
  }
  tr.arrived = true;
}

/**
 * Advance seg past the just-arrived corner the id way (train_next):
 * self->target was set to ent->target when the corner was picked, so the
 * next leg goes to the corner NAMED by the arrived corner's target link —
 * not to the next array slot. A link back into the chain (base1's ship
 * loops close t147->t143, t141->t137, t130->t131, each a TELEPORT corner)
 * wraps seg and the train runs forever; an empty or dangling link ends the
 * chain (C prints "bad target" and returns).
 */
function advanceTrainSeg(tr: Train): boolean {
  const cur = tr.corners[tr.seg];
  const next = cur ? cur.target : '';
  if (!next) {
    tr.arrived = true;
    tr.waitUntil = -1;
    return false;
  }
  const idx = tr.corners.findIndex((c) => c.name === next);
  if (idx < 0) {
    tr.arrived = true;
    tr.waitUntil = -1;
    return false;
  }
  tr.seg = idx;
  return true;
}

/** Use a train/ship the id way (train_use / misc_strogg_ship_use). */
export function startTrain(tr: Train, now: number): void {
  void now;
  if (tr.arrived) return;
  if (tr.halted) {
    // TOGGLE resume (train_resume): re-run the leg to the current corner.
    tr.halted = false;
    if (tr.seg < tr.corners.length) trainNext(tr, now);
    return;
  }
  if (!tr.started) {
    tr.started = true;
    if (tr.seg >= tr.corners.length) {
      tr.arrived = true;
      return;
    }
    trainNext(tr, now);
    return;
  }
  // C train_use: START_ON without TOGGLE ignores use while running; with
  // TOGGLE it stops mid-leg (START_ON cleared, velocity zeroed).
  if (tr.toggle) tr.halted = true;
}

/**
 * C train_blocked damage rules (game/g_func.c): debris/gibs take 100000
 * (+ the BecomeExplosion1 nuke — `crush` tells the caller to free them);
 * players/monsters take dmg debounced at 0.5s (BLOCK_STOPS doors deal 0
 * but still consume the debounce). Null while debounced.
 */
export function trainBlocked(
  tr: Train,
  victimKind: 'player' | 'monster' | 'other',
  now: number,
): { dmg: number; crush: boolean } | null {
  if (victimKind === 'other') return { dmg: CRUSH_DAMAGE, crush: true };
  if (now < tr.touchDebounce) return null;
  tr.touchDebounce = now + MOVER_TOUCH_DEBOUNCE;
  return { dmg: tr.dmg, crush: false };
}

/**
 * Advance one train by dt seconds at constant speed (Move_Calc-lite: id
 * eases with accel/decel; constant speed matches average arrival and keeps
 * the mover deterministic for tests). On arrival runs the train_wait
 * sequence: fires pathtarget, honors the corner wait, then continues or
 * stops when the chain ends. Returns the displacement this tick.
 */
export function trainThink(tr: Train, now: number, dt: number, fire: (targetname: string) => void): Vec3 {
  const ox = tr.ent.origin[0]!;
  const oy = tr.ent.origin[1]!;
  const oz = tr.ent.origin[2]!;
  if (!tr.started || tr.arrived || tr.halted) return v3(0, 0, 0);
  if (tr.waitUntil >= 0) {
    if (now < tr.waitUntil) return v3(0, 0, 0);
    if (!advanceTrainSeg(tr)) return v3(0, 0, 0);
    trainNext(tr, now);
    if (tr.arrived) return v3(0, 0, 0);
  }
  const dx = tr.to[0]! - tr.ent.origin[0]!;
  const dy = tr.to[1]! - tr.ent.origin[1]!;
  const dz = tr.to[2]! - tr.ent.origin[2]!;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const step = tr.speed * dt;
  if (len <= step || len === 0) {
    tr.ent.origin[0] = tr.to[0]!;
    tr.ent.origin[1] = tr.to[1]!;
    tr.ent.origin[2] = tr.to[2]!;
    // train_wait: fire pathtarget, then wait or continue.
    const dest = tr.corners[tr.seg];
    if (dest && dest.pathtarget) fire(dest.pathtarget);
    if (!dest || dest.wait === 0) {
      if (advanceTrainSeg(tr)) trainNext(tr, now);
    } else if (dest.wait > 0) {
      tr.waitUntil = now + dest.wait;
    } else if (tr.toggle) {
      // C train_wait: wait < 0 with TRAIN_TOGGLE stops (START_ON cleared,
      // nextthink 0); a later use resumes via train_resume.
      tr.halted = true;
      tr.waitUntil = -1;
    } else {
      // C train_wait: wait < 0 without TOGGLE halts with nextthink 0.
      tr.arrived = true;
      tr.waitUntil = -1;
    }
  } else {
    const k = step / len;
    tr.ent.origin[0] = tr.ent.origin[0]! + dx * k;
    tr.ent.origin[1] = tr.ent.origin[1]! + dy * k;
    tr.ent.origin[2] = tr.ent.origin[2]! + dz * k;
  }
  return v3(tr.ent.origin[0]! - ox, tr.ent.origin[1]! - oy, tr.ent.origin[2]! - oz);
}
/**
 * Spawn a full entities lump: creates edicts for every block and wires
 * movers/triggers/trains/monsters for the classes base1 needs. Unknown
 * classes are kept as plain edicts (decorations, lights, banners).
 *
 * Skill gating (g_spawn.c): edicts carrying SPAWNFLAG_NOT_* for the state's
 * skill never spawn (worldspawn exempt). The NOT bits are stripped from
 * spawned edicts afterwards, exactly like C.
 *
 * `modelSizes` is the WIRE hook for id-correct door travel: SP_func_door
 * computes travel as |movedir| . brushSize - lip from the brush model bounds,
 * which only the BSP side knows. When a model resolves, its size-based travel
 * is used; otherwise the legacy `distance`-key default (128) applies.
 *
 * `dropTrace` is the M_droptofloor hook (SV_DropTraceFor: MASK_MONSTERSOLID
 *   per C, for both barrels and monsters): barrels and non-triggered monsters
 *   snap to the floor at spawn; without it mapper origins are kept verbatim.
 */
export function SV_SpawnEntities(
  st: ServerState,
  text: string,
  modelSizes?: (model: string) => { mins: Float32Array; maxs: Float32Array } | null,
  dropTrace?: TraceFn,
): Edict[] {
  resetEdictNums();
  const out: Edict[] = [];
  const dicts = parseEntities(text);
  // C PlayerTrail_Init (g_spawn.c SpawnEntities): fresh pursuit memory every
  // spawn (always active in SP; deathmatch never inits — our sim is SP-only).
  st.trail = trailInit(true);
  st.combatPoints = [];
  st.levelName = '';
  dicts.forEach((dict, index) => {
    const spawnflags = parseFloat(dict['spawnflags'], 0);
    // Skill inhibit (g_spawn.c); worldspawn (first block) is exempt.
    if (index > 0 && inhibitedBySkill(spawnflags, st.skill)) return;
    const e = spawnEdict(dict);
    // C strips the NOT bits after the check so later logic sees clean flags.
    e.spawnflags &= ~(
      SPAWNFLAG_NOT_EASY |
      SPAWNFLAG_NOT_MEDIUM |
      SPAWNFLAG_NOT_HARD |
      SPAWNFLAG_NOT_DEATHMATCH |
      SPAWNFLAG_NOT_COOP
    );
    SV_LinkEdict(st, e);
    out.push(e);
    // C level.level_name: the worldspawn `message` is the map title the F1
    // help computer shows (base1: "Outer Base"). First block only in C
    // (worldspawn is dicts[0]); later blocks never carry the classname.
    if (e.classname === 'worldspawn' && index === 0) st.levelName = dict['message'] ?? '';
    const angle = parseFloat(dict['angle'], 0);
    switch (e.classname) {
      case 'func_door': {
        let distance = parseFloat(dict['distance'], 128);
        const model = dict['model'];
        if (modelSizes && model) {
          const bounds = modelSizes(model);
          if (bounds) {
            const size = [
              bounds.maxs[0]! - bounds.mins[0]!,
              bounds.maxs[1]! - bounds.mins[1]!,
              bounds.maxs[2]! - bounds.mins[2]!,
            ] as [number, number, number];
            const lip = e.lip || 8;
            distance = doorTravel(new Float32Array(size), angle, lip) + lip;
            const m = spawnDoor(e, angle, distance);
            SV_SpawnMover(st, m);
            st.moverBounds.set(e.num, { mins: bounds.mins, maxs: bounds.maxs });
            break;
          }
        }
        SV_SpawnMover(st, spawnDoor(e, angle, distance));
        break;
      }
      case 'func_door_secret': {
        // C sizes the back-out/slide from the brush bounds; without the
        // BSP hook the door is degenerate (zero travel, like C's empty size).
        let size: Vec3 | null = null;
        const model = dict['model'];
        if (modelSizes && model) {
          const bounds = modelSizes(model);
          if (bounds) {
            size = v3(
              bounds.maxs[0]! - bounds.mins[0]!,
              bounds.maxs[1]! - bounds.mins[1]!,
              bounds.maxs[2]! - bounds.mins[2]!,
            );
          }
        }
        st.secretDoors.push(spawnSecretDoor(e, size));
        break;
      }
      case 'func_door_rotating': {
        const rm = spawnRotDoor(e);
        st.rotDoors.push(rm);
        const model = dict['model'];
        if (modelSizes && model) {
          const bounds = modelSizes(model);
          if (bounds) st.moverBounds.set(e.num, { mins: bounds.mins, maxs: bounds.maxs });
        }
        break;
      }
      case 'func_plat': {
        // C SOLID_BSP while standing: plats carry riders (SV_Push), so the
        // driver trace must see the brush — record bounds like doors.
        const m = spawnPlat(e, parseFloat(dict['height'], 160));
        SV_SpawnMover(st, m);
        const model = dict['model'];
        if (modelSizes && model) {
          const bounds = modelSizes(model);
          if (bounds) st.moverBounds.set(e.num, { mins: bounds.mins, maxs: bounds.maxs });
        }
        break;
      }
      case 'func_button': {
        const m = spawnButton(e, angle);
        const model = dict['model'];
        if (modelSizes && model) {
          const bounds = modelSizes(model);
          if (bounds) {
            // RELEASE-4 departure (base1 *34 only): see BUTTON_34_SHIFT in
            // buttons.ts — lump entombed in shut plug, shifted to east face
            // center (Y preserved) so normal central entry faces it. Both
            // collision (here) and rendering (apps/web DoorSync/graft) apply
            // the same shift; visual/collision divergence is a blocker.
            let bmins = bounds.mins;
            let bmaxs = bounds.maxs;
            if (model === '*34') {
              bmins = new Float32Array([bmins[0]! + BUTTON_34_SHIFT[0], bmins[1]! + BUTTON_34_SHIFT[1], bmins[2]! + BUTTON_34_SHIFT[2]]);
              bmaxs = new Float32Array([bmaxs[0]! + BUTTON_34_SHIFT[0], bmaxs[1]! + BUTTON_34_SHIFT[1], bmaxs[2]! + BUTTON_34_SHIFT[2]]);
            }
            st.moverBounds.set(e.num, { mins: bmins, maxs: bmaxs });
            // C SP_func_button travel is |movedir| . brushSize - lip
            // (g_func.c), not lip: spawnButton's lip-only pos2 leaves the
            // pressed *34 one unit proud, and its expanded hull then pins a
            // walker at the walkway step (start-inside allsolid) after the
            // button visibly sank flush. Correct pos2 when bounds are known.
            const size = v3(
              bounds.maxs[0]! - bounds.mins[0]!,
              bounds.maxs[1]! - bounds.mins[1]!,
              bounds.maxs[2]! - bounds.mins[2]!,
            );
            const travel = doorTravel(size, angle, m.lip);
            const dir = moveDirForAngle(angle);
            m.pos2 = v3(
              m.pos1[0]! + dir[0]! * travel,
              m.pos1[1]! + dir[1]! * travel,
              m.pos1[2]! + dir[2]! * travel,
            );
          }
        }
        SV_SpawnMover(st, m);
        break;
      }
      case 'trigger_once':
      case 'trigger_multiple': {
        let bounds: { mins: Float32Array; maxs: Float32Array } | null = null;
        const model = dict['model'];
        if (modelSizes && model) {
          const b = modelSizes(model);
          if (b) bounds = b;
        }
        SV_SpawnTrigger(st, spawnTrigger(e), bounds ?? undefined);
        break;
      }
      case 'misc_explobox': {
        // SP_misc_explobox thinks M_droptofloor on spawn. The edict doubles
        // as the server barrel record (health/dmg from the game tables,
        // origin = box bottom = hull origin; Phase 0 single sim).
        if (dropTrace) {
          const g = droptofloor(e.origin, EXPLOBOX_MINS, EXPLOBOX_MAXS, dropTrace);
          e.origin[0] = g[0]!;
          e.origin[1] = g[1]!;
          e.origin[2] = g[2]!;
        }
        {
          const ex = spawnExplosive(dict);
          if (ex) {
            e.health = ex.health;
            e.maxHealth = ex.health;
            e.dmg = ex.dmg;
            st.barrels.push({
              edict: e,
              origin: v3(e.origin[0], e.origin[1], e.origin[2]),
              size: v3(EXPLOBOX_MAXS[0]! - EXPLOBOX_MINS[0]!, EXPLOBOX_MAXS[1]! - EXPLOBOX_MINS[1]!, EXPLOBOX_MAXS[2]! - EXPLOBOX_MINS[2]!),
              mass: ex.mass,
              isFunc: false,
              fused: false,
            });
          }
        }
        break;
      }
      case 'func_explosive':
      case 'func_wall': {
        // C SOLID_BSP while standing (SP_func_explosive / SP_func_wall):
        // block movement until destroyed. Submodel bounds are already
        // world-space (brush-model origins are 0 in base1), so no mover
        // offset applies, unlike doors.
        const model = dict['model'];
        if (modelSizes && model) {
          const bounds = modelSizes(model);
          if (bounds) st.brushClips.set(e.num, { mins: bounds.mins, maxs: bounds.maxs });
        }
        // func_explosive is a shootable barrel too (barrel_delay fuse +
        // T_RadiusDamage + mass-formula debris): record the center + size so
        // SV_DamageBarrel and the driver render path share one record.
        if (e.classname === 'func_explosive') {
          const ex = spawnExplosive(dict);
          if (ex) {
            e.health = ex.health;
            e.maxHealth = ex.health;
            e.dmg = ex.dmg;
            const model = dict['model'];
            const bounds = model && modelSizes ? modelSizes(model) : null;
            if (bounds) {
              const cx = (bounds.mins[0]! + bounds.maxs[0]!) / 2;
              const cy = (bounds.mins[1]! + bounds.maxs[1]!) / 2;
              const cz = (bounds.mins[2]! + bounds.maxs[2]!) / 2;
              st.barrels.push({
                edict: e,
                origin: v3(cx, cy, cz),
                size: v3(bounds.maxs[0]! - bounds.mins[0]!, bounds.maxs[1]! - bounds.mins[1]!, bounds.maxs[2]! - bounds.mins[2]!),
                mass: ex.mass,
                isFunc: true,
                fused: false,
              });
            }
          }
        }
        break;
      }
      case 'func_train':
      case 'misc_strogg_ship': {
        // Placed on the first path_corner below (needs the full edict list).
        const ship = e.classname === 'misc_strogg_ship';
        let base: Vec3 = v3(SHIP_BASE[0], SHIP_BASE[1], SHIP_BASE[2]);
        const model = dict['model'];
        if (!ship && modelSizes && model) {
          const bounds = modelSizes(model);
          if (bounds) {
            base = v3(bounds.mins[0], bounds.mins[1], bounds.mins[2]);
            st.moverBounds.set(e.num, { mins: bounds.mins, maxs: bounds.maxs });
          }
        }
        st.trains.push({
          ent: e,
          ship,
          base,
          corners: [],
          seg: 1,
          from: v3(e.origin[0], e.origin[1], e.origin[2]),
          to: v3(e.origin[0], e.origin[1], e.origin[2]),
          waitUntil: -1,
          started: false,
          arrived: false,
          speed: e.speed || (ship ? 300 : 100),
          toggle: (e.spawnflags & 2) !== 0, // TRAIN_TOGGLE
          halted: false,
          // SP_func_train: BLOCK_STOPS deals 0, otherwise dmg defaults 100.
          dmg: (e.spawnflags & 4) !== 0 ? 0 : e.dmg || 100,
          touchDebounce: 0,
        });
        break;
      }
      case 'point_combat': {
        // C SP_point_combat (g_misc.c): firing-position marker, linked by
        // targetname from a monster's combattarget. Recorded by targetname
        // so FoundTarget can install it as the monster's combat goal.
        st.combatPoints.push({
          targetname: e.targetname,
          pos: v3(e.origin[0], e.origin[1], e.origin[2]),
          hold: (e.spawnflags & 1) !== 0,
          target: e.target,
          pathtarget: dict['pathtarget'] ?? '',
        });
        break;
      }
      case 'target_help': {
        // C SP_target_help (g_target.c): deathmatch removal is N/A (this
        // sim is SP-only); edicts with no message are freed at spawn
        // (G_FreeEdict) so a later use can never latch an empty string.
        if (!e.message) e.freed = true;
        break;
      }
      case 'misc_deadsoldier': {
        // C SP_misc_deadsoldier (g_misc.c): a corpse in a fixed pose
        // (spawnflags bits -> deadbod dude MD2 frame, resolved view-side),
        // SOLID_BBOX 32x32x16 + MOVETYPE_NONE, DAMAGE_YES at DEAD_DEAD
        // (gibbed past -80hp). Deathmatch removes them; this sim is SP-only
        // so they always spawn. Takedamage/deadflag have no Edict fields and
        // no clip entry consumes the bbox, so corpses persist as scenery:
        // never freed, never blocking, rendered from the roster every frame.
        e.solid = SOLID_BBOX;
        e.movetype = MOVETYPE_NONE;
        e.mins = v3(-16, -16, 0);
        e.maxs = v3(16, 16, 16);
        break;
      }
      case 'light': {
        // C SP_light (g_misc.c): targeted style>=32 lights install light_use;
        // untargeted ones bake into the lightmap (their edicts are decorative
        // here). The initial CS_LIGHTS payload is "a" under START_OFF(1),
        // else "m" — light_use flips it from there.
        if (e.targetname) {
          const style = Number.parseInt(dict['style'] ?? '', 10);
          if (Number.isFinite(style) && style >= 32) {
            st.lightStyles[style] = (e.spawnflags & 1) !== 0 ? 'a' : 'm';
          }
        }
        break;
      }
      case 'func_areaportal': {
        // C SP_func_areaportal: the portal starts closed
        // (gi.SetAreaPortalState(style, false) at spawn); door travel opens
        // and closes it from here on (see setDoorPortals).
        if (e.targetname) st.areaPortals[e.targetname] = false;
        break;
      }
      default:
        break;
    }
    // C droptofloor (g_items.c): map items link SOLID_TRIGGER + Touch_Item
    // (mins/maxs ±15, MOVETYPE_TOSS until they rest). The sim never tosses —
    // origins stay mapper-placed — but the solid is what touch checks test,
    // so spawn it here: without this every item spawns SOLID_NOT and only
    // the driver's box-proximity fallback can ever collect it. Skill-inhibited
    // (DM-only) edicts never reach this line; key_power_cube's
    // TRIGGER_SPAWN/NO_TOUCH variants keep TRIGGER (base1 ships no keys, and
    // the use-gated cube path is out of scope).
    if (
      e.classname.startsWith('item_') ||
      e.classname.startsWith('weapon_') ||
      e.classname.startsWith('ammo_') ||
      e.classname.startsWith('key_')
    ) {
      e.solid = SOLID_TRIGGER;
    }
    // Scripted explosion targets (target_explosion, g_target.c
    // use_target_explosion): recorded by targetname so SV_Tick can fire
    // them when the relay chain reaches them (Phase 0 single sim — the
    // driver used to own this table). Every same-named charge is kept:
    // base1's t151 is four edicts (four positions/delays, one name).
    if (e.classname === 'target_explosion' && e.targetname) {
      const ex = spawnExplosive(dict);
      if (ex) {
        const list = st.explosionTargets.get(e.targetname) ?? [];
        list.push({
          origin: v3(ex.origin[0], ex.origin[1], ex.origin[2]),
          dmg: ex.dmg,
          delay: ex.delay,
        });
        st.explosionTargets.set(e.targetname, list);
      }
    }
    // Ambient spark shower (target_splash, g_target.c use_target_splash):
    // TE_SPLASH count/dir/sounds. C defaults count to 32 and derives the
    // spray direction with G_SetMovedir (angle -1 = up, -2 = down, else
    // yaw). Base1's 12 splashes are all sounds 1 (sparks), none carry dmg.
    if (e.classname === 'target_splash' && e.targetname) {
      const list = st.splashes.get(e.targetname) ?? [];
      list.push({
        origin: v3(e.origin[0], e.origin[1], e.origin[2]),
        count: e.count > 0 ? e.count : 32,
        sounds: e.sounds,
        dmg: e.dmg,
        dir: splashMovedir(dict),
      });
      st.splashes.set(e.targetname, list);
    }
    // Positional speaker (target_speaker, g_target.c Use_Target_Speaker).
    // C appends .wav when the noise lacks it and drops noiseless edicts
    // (no use func ever runs for them). Volume/attenuation default 1.
    if (e.classname === 'target_speaker' && e.targetname) {
      let noise = dict['noise'] ?? '';
      if (noise && !noise.includes('.wav')) noise += '.wav';
      if (noise) {
        const list = st.speakers.get(e.targetname) ?? [];
        list.push({
          origin: v3(e.origin[0], e.origin[1], e.origin[2]),
          noise,
          looped: (e.spawnflags & 3) !== 0,
        });
        st.speakers.set(e.targetname, list);
      }
    }
    // Prestarted loop ambience (game/g_target.c SP_target_speaker:
    // spawnflags&1 sets ent->s.sound at spawn, named or not): a persistent
    // loop-channel entry the audio lane consumes (start = added, stop =
    // removed, position = pos). Base1's 57 unnamed ambients ride this path;
    // named prestarted loops join the toggle table below as well.
    if (e.classname === 'target_speaker' && (e.spawnflags & 1) !== 0) {
      let prestart = dict['noise'] ?? '';
      if (prestart && !prestart.includes('.wav')) prestart += '.wav';
      if (prestart) {
        st.sounds.push({
          name: prestart,
          pos: v3(e.origin[0], e.origin[1], e.origin[2]),
          born: st.time,
          loop: true,
        });
      }
    }
    // Ambient timer (func_timer, g_func.c SP_func_timer): wait defaults to
    // 1.0, random clamps to wait - 0.1, START_ON (spawnflags & 1) fires
    // from spawn at 1 + delay + wait (C adds the spawn pausetime fraction
    // and one crandom spread the reschedules keep carrying).
    if (e.classname === 'func_timer') {
      const wait = e.wait > 0 ? e.wait : 1;
      const randomRaw = parseFloat(dict['random'] ?? '', 0);
      const random = Number.isFinite(randomRaw) && randomRaw > 0
        ? Math.min(randomRaw, wait - SERVER_DT)
        : 0;
      const delayRaw = parseFloat(dict['delay'] ?? '', 0);
      const delay = Number.isFinite(delayRaw) && delayRaw > 0 ? delayRaw : 0;
      st.timers.push({
        ent: e,
        target: e.target,
        wait,
        random,
        delay,
        nextAt: (e.spawnflags & 1) !== 0 ? 1 + delay + wait : -1,
      });
    }
    if (e.classname.startsWith('monster_')) {      // id skin assignment (m_soldier.c SP_monster_soldier_*): light troops
      // wear skin 0 (blaster), normals skin 2 (shotgun), supershots skin 4
      // (machinegun). Stashed on the edict so the render lane can pick a
      // distinct skin per kind (selectSoldierAttack keys off the same skins).
      // Base1 fields 6× light + 8× normal, no supershots.
      if (e.classname === 'monster_soldier_light') e.extra['skinnum'] = '0';
      else if (e.classname === 'monster_soldier') e.extra['skinnum'] = '2';
      else if (e.classname === 'monster_soldier_ss') e.extra['skinnum'] = '4';
      // C solidity (m_soldier.c / m_infantry.c / m_gunner.c SP_ funcs set
      // MOVETYPE_STEP + SOLID_BBOX; walkmonster_start_go routes spawnflags & 2
      // through monster_triggered_start: SOLID_NOT + MOVETYPE_NONE +
      // SVF_NOCLIENT until monster_triggered_spawn_use wakes them). Without
      // this every monster spawns SOLID_NOT and the player walks through.
      // walkmonster_start_go drops non-triggered monsters when level.time < 1
      // (spawn always qualifies: time is still 0 here).
      if (e.spawnflags & 2) {
        e.solid = SOLID_NOT;
        e.movetype = MOVETYPE_NONE;
      } else {
        e.solid = SOLID_BBOX;
        e.movetype = MOVETYPE_STEP;
      }
      if (dropTrace && !(e.spawnflags & 2)) {
        const g = droptofloor(e.origin, MONSTER_HULL_MINS, MONSTER_HULL_MAXS, dropTrace);
        e.origin[0] = g[0]!;
        e.origin[1] = g[1]!;
        e.origin[2] = g[2]!;
      }
      const kind = monsterKindOf(e.classname);
      const monster: ServerMonster = {
        edict: e,
        state: kind ? spawnMonster(kind) : spawnMonster('soldier'),
        kind,
        ambush: (e.spawnflags & 1) !== 0,
        triggered: (e.spawnflags & 2) !== 0,
        woken: false,
        seen: false,
        reactionAt: 0,
        duckUntil: 0,
        duckShoot: false,
        burstUntil: 0,
        burstHeld: false,
        combatGoal: null,
        combatHold: false,
        combatDone: false,
        slideDir: 0,
        patrolCorner: '',
        patrolGoal: null,
        patrolWaitUntil: 0,
      };
      st.monsters.push(monster);
      // C spawn HP per skin (m_soldier.c SP_ funcs): light 20, normal 30,
      // ss 40 — the shared lite def defaults to the normal class.
      if (kind === 'soldier') {
        const skin = Number.parseInt((e.extra['skinnum'] as string) ?? '2', 10);
        monster.state.health = soldierHealthForSkin(Number.isFinite(skin) ? skin : 2);
      }
      if (kind) {
        // face the mapper angle until the first tick re-yaws (M_ChangeYaw).
        const yaw = parseFloat(dict['angle'], 0);
        const last = st.monsters[st.monsters.length - 1]!;
        last.state.yaw = ((yaw % 360) + 360) % 360;
      }
    }
  });
  // Second pass: trains need the full edict list to resolve corner chains
  // (func_train_find runs on the second frame in C, after all spawns).
  for (const tr of st.trains) {
    tr.corners = resolveCorners(st.entities, tr.ent.target);
    if (tr.corners.length === 0) {
      tr.arrived = true;
      continue;
    }
    placeTrain(tr);
    // Ships/trains with no targetname start immediately (func_train_find);
    // named ones wait for a use (trigger_always, buttons).
    if (!tr.ent.targetname) {
      tr.started = true;
      trainNext(tr, 0);
    }
  }
  // Second pass: monster target links (g_monster.c monster_start_go runs
  // after all spawns too). A target naming a point_combat becomes the
  // combattarget (base1's t67 soldier); a target naming a path_corner starts
  // the patrol beat, facing the first corner (base1's ten beat cops).
  // Triggered bodies resolve on wake instead (monster_triggered_spawn) —
  // see resolveMonsterTarget, shared with SV_UseMonster.
  for (const m of st.monsters) {
    if (!m.triggered) resolveMonsterTarget(st, m);
  }
  // SP_trigger_always: fire at spawn (starts base1's ships; the exit train's
  // own trigger_always is skill-inhibited in SP, so the train waits for *13).
  // Explosion targets fire for real too (none in base1, but the path is the
  // same use_target_explosion fuse the tick runs for relay chains).
  // Team doors share one travel time (Think_CalcMoveSpeed: the shortest move
  // governs so multi-part doors arrive together).
  applyTeamMoveSpeeds(st.movers);
  // C level.* totals (g_local.h): captured at spawn, before trigger_always
  // fires a single frame later — every spawned monster counts (C
  // walkmonster_start_go increments for all non-good-guy bodies; this sim
  // has no good-guy flag and base1 ships none), every SP target_secret /
  // target_goal counts (skill-inhibited edicts never spawned, like C).
  st.totalMonsters = st.monsters.length;
  st.totalSecrets = out.filter((e) => !e.freed && e.classname === 'target_secret').length;
  st.totalGoals = out.filter((e) => !e.freed && e.classname === 'target_goal').length;
  for (const e of out) {
    if (!e.freed && e.classname === 'trigger_always' && e.target) {
      const pseudo: Edict = { ...e };
      fireTargets(st, pseudo);
      fireExplosionTarget(st, e.target);
    }
  }
  return out;
}

/**
 * Monster spawn target resolution (g_monster.c monster_start_go, runs after
 * all spawns — and late for triggered bodies at wake). A target naming a
 * point_combat becomes the combattarget (FoundTarget heads there on
 * acquire); a target naming a path_corner starts the patrol beat, facing
 * the first corner with the walk move (base1's beat cops); anything else
 * (a packmate targetname like t40, a dangling link) stands until seen.
 * The edict target is kept for monster_death_use (C clears it for the
 * combattarget fixup, but the t39→t40 death chain needs it; firing a
 * point_combat targetname on death is a no-op in fireTargets).
 */
export function resolveMonsterTarget(st: ServerState, m: ServerMonster): void {
  const target = m.edict.target;
  if (!target || m.kind === null) return;
  const named = st.entities.filter((e) => !e.freed && e.targetname === target);
  if (named.some((e) => e.classname === 'point_combat')) {
    m.edict.extra['combattarget'] = target;
    return;
  }
  const corners = patrolCornersOf(st);
  const first = patrolStart(corners, target);
  if (!first) return;
  m.patrolCorner = first.name;
  m.patrolGoal = v3(first.pos[0], first.pos[1], first.pos[2]);
  // C faces the first corner outright (ideal_yaw = angles[YAW] = vectoyaw).
  m.state.yaw = monsterYawTo(m.edict.origin, m.patrolGoal);
  if (!m.state.dead && !m.state.gibbed) {
    m.state.move = patrolWalkMove(m.kind);
    m.state.frame = 0;
  }
}

/**
 * id G_UseTargets on a monster edict (g_monster.c): TRIGGER_SPAWN bodies
 * wake via monster_triggered_spawn_use (solid + visible + thinking next
 * frame; the activator becomes the enemy unless ambush holds it), while a
 * live non-triggered monster answers monster_use by acquiring the activator
 * (seen latches so it attacks/pursues instead of idling). Dead/gibbed
 * bodies ignore uses. `byPlayer` marks a client activator (pickup/death
 * chains in this sim are always player-caused; doors/buttons pass false).
 */
export function SV_UseMonster(m: ServerMonster, byPlayer: boolean, st?: ServerState): void {
  if (m.state.gibbed || m.state.dead) return;
  if (m.triggered && !m.woken) {
    // monster_triggered_start -> monster_triggered_spawn_use: one frame
    // delay in C before think resumes (nextthink = level.time + FRAMETIME);
    // the lite sim wakes immediately (think runs next tick anyway).
    m.woken = true;
    // C monster_triggered_spawn: SOLID_BBOX + MOVETYPE_STEP + SVF_NOCLIENT
    // clear (KillBox + linkentity). The spawn set SOLID_NOT, so set it here
    // or woken bodies stay intangible to movement forever.
    m.edict.solid = SOLID_BBOX;
    m.edict.movetype = MOVETYPE_STEP;
    // monster_triggered_spawn: non-ambush FoundTarget (acquire now), ambush
    // keeps enemy NULL and waits for line of sight.
    if (byPlayer && !m.ambush) m.seen = true;
    // The use carries no clock; stamp the sight-delay on the next tick
    // (reactionAt -1 = pending, resolved against level.time there).
    if (m.seen) m.reactionAt = -1;
    // monster_triggered_spawn runs the spawn target resolution late
    // (walkmonster_start_go): patrol beats start on wake, not on lump spawn.
    if (st) resolveMonsterTarget(st, m);
    return;
  }
  if (!m.triggered && byPlayer && !m.seen) {
    m.seen = true;
    m.reactionAt = -1;
  }
}

/** Fire a "use" on every entity with the given targetname (button/trigger path). */
export function SV_UseTargetname(st: ServerState, targetname: string): void {
  for (const m of st.movers) {
    if (m.ent.targetname === targetname) SV_UseMover(st, m);
  }
  for (const sm of st.secretDoors) {
    // Secret doors fire nothing on use (C door_secret_use skips G_UseTargets).
    if (sm.ent.targetname === targetname) secretUse(sm, st.time);
  }
  for (const rm of st.rotDoors) {
    if (rm.ent.targetname === targetname) SV_UseRotDoor(st, rm);
  }
  for (const tr of st.trains) {
    if (tr.ent.targetname === targetname) startTrain(tr, st.time);
  }
  for (const m of st.monsters) {
    if (!m.edict.freed && m.edict.targetname === targetname) SV_UseMonster(m, true, st);
  }
  for (const e of st.entities) {
    if (e.targetname === targetname && e.classname === 'trigger_relay') {
      fireTargets(st, e);
    }
  }
  for (const t of st.timers) {
    // C G_UseTargets reaches func_timer edicts by targetname (func_timer_use
    // toggles the loop): base1's t120/t121 timers start on trigger_once.
    if (!t.ent.freed && t.ent.targetname === targetname) useTimer(st, t);
  }
}

/**
 * Use a mover the id way (G_UseTargets equivalent for movers): run moverUse,
 * and when a func_door starts opening, fire the door's own target right away
 * (id door_go_up calls G_UseTargets the moment the door starts moving — not
 * on arrival). Buttons instead fire on reaching the top (see SV_Tick,
 * id button_wait); plats never fire. Depth-guarded: cyclic target graphs
 * stop instead of overflowing the stack (a deliberate safety deviation).
 */
export function SV_UseMover(st: ServerState, m: Mover, depth = 0): void {
  const before = m.state;
  moverUse(m, st.time);
  // C door_go_up / door_go_down / button_fire: a newly started leg plays
  // sound_start (doorLegStartSound) and — for an opening door — fires the
  // door's target (G_UseTargets the moment the door starts moving, not on
  // arrival) plus door_use_areaportals(true).
  const legStarted =
    (m.state === MOVER_GOING_UP || m.state === MOVER_GOING_DOWN) && m.state !== before;
  if (legStarted) doorLegStartSound(st, m);
  if (
    before !== MOVER_GOING_UP &&
    m.state === MOVER_GOING_UP &&
    m.ent.classname === 'func_door'
  ) {
    if (m.ent.target) fireTargets(st, m.ent, depth + 1);
    setDoorPortals(st, m.ent, true);
  }
}

/** Maximum G_UseTargets cascade depth (cycle guard; id would recurse). */
export const MAX_USETARGETS_DEPTH = 16;

/**
 * Use a rotating door the id way (door_use / door_go_up, angular branch):
 * an opening leg plays sound_start and fires the door's target right away
 * (C door_go_up runs G_UseTargets); TOGGLE close legs fire nothing.
 * Returns the rotUse verdict so touch sites can share the one call.
 */
export function SV_UseRotDoor(st: ServerState, rm: RotMover): 'opened' | 'closed' | null {
  const res = rotUse(rm, st.time);
  if (res === null) return null;
  if (res === 'opened') {
    if (!rm.silent) {
      st.sounds.push({
        name: DOOR_SOUND_START,
        pos: v3(rm.ent.origin[0], rm.ent.origin[1], rm.ent.origin[2]),
        born: st.time,
      });
    }
    fireTargets(st, rm.ent);
    setDoorPortals(st, rm.ent, true);
  }
  return res;
}

/**
 * Positive `delay` seconds on an edict (game/g_utils.c G_UseTargets: any
 * nonzero delay spawns the DelayedUse think at level.time + delay). Read off
 * `extra` — Edict carries no delay field; the key survives verbatim there.
 */
export function entDelay(e: Edict): number {
  const d = parseFloat(e.extra?.['delay'] ?? '', 0);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/**
 * Copy an edict for the DelayedUse think (game/g_utils.c Think_Delay): the
 * temp object carries message/target/killtarget but NO delay — otherwise the
 * think would defer itself forever instead of firing once.
 */
export function stripDelayForThink(e: Edict): Edict {
  const extra = { ...e.extra };
  delete extra['delay'];
  return { ...e, extra };
}

/**
 * C door_use_areaportals (game/g_func.c:852): open/close every
 * func_areaportal whose targetname the door targets. G_UseTargets skips
 * func_areaportal targets when the user is a door (the `continue` in
 * g_utils.c), so the record here is the ONLY portal driver — call it on
 * every portal-affecting door transition, never through the target loop.
 */
export function setDoorPortals(st: ServerState, door: Edict, open: boolean): void {
  if (!door.target) return;
  for (const e of st.entities) {
    if (!e.freed && e.classname === 'func_areaportal' && e.targetname === door.target) {
      st.areaPortals[e.targetname] = open;
    }
  }
}

/**
 * Leg-start voice for a linear mover (game/g_func.c door_go_up /
 * door_go_down sound_start, button_fire sound_start): doors/dr1_strt.wav
 * for func_door, switches/butn2.wav for func_button — each suppressed when
 * sounds == 1 (C SP_func_door / SP_func_button install no sound index then).
 * Called on every leg start (UP and TOGGLE-close legs alike); arrivals are
 * silent except the door's sound_end (see SV_Tick).
 */
export function doorLegStartSound(st: ServerState, m: Mover): void {
  if (m.ent.sounds === 1) return;
  if (m.ent.classname === 'func_door') {
    st.sounds.push({
      name: DOOR_SOUND_START,
      pos: v3(m.ent.origin[0], m.ent.origin[1], m.ent.origin[2]),
      born: st.time,
    });
  } else if (m.ent.classname === 'func_button') {
    st.sounds.push({
      name: BUTTON_SOUND_START,
      pos: v3(m.ent.origin[0], m.ent.origin[1], m.ent.origin[2]),
      born: st.time,
    });
  }
}

/**
 * G_UseTargets equivalent (game/g_utils.c:173): use every entity targeted by
 * `user`. Delay first (a delayed use schedules a DelayedUse think and does
 * nothing synchronously — not even the message or the firedThisTick push),
 * then the message branch (ent->message centerprints + misc/talk1.wav for a
 * non-monster activator; this sim is SP-only so the activator is the
 * player), then the target loop. Relay/door/button/timer recursions re-enter
 * here, so delayed uses and messages on THOSE entities resolve at their own
 * level — the loop never prints or schedules for a target itself.
 */
export function fireTargets(st: ServerState, user: Edict, depth = 0): void {
  if (depth > MAX_USETARGETS_DEPTH) return;
  // C delay branch: the whole use (message included) waits for the think.
  const delay = entDelay(user);
  if (delay > 0) {
    st.delayed.push({ at: st.time + delay, ent: stripDelayForThink(user), depth });
    return;
  }
  // C message branch: print + talk1 (or the entity's own noise when it
  // carries one — no base1 messaged entity does, so talk1 is the sound).
  if (user.message) {
    st.centerprints.push(user.message);
    st.sounds.push({
      name: 'misc/talk1.wav',
      pos: v3(user.origin[0], user.origin[1], user.origin[2]),
      born: st.time,
    });
  }
  if (!user.target) return;
  // C G_UseTargets skips func_areaportal targets when the user is a door —
  // doors drive portals through door_use_areaportals only (setDoorPortals).
  const userIsDoor = user.classname === 'func_door' || user.classname === 'func_door_rotating';
  for (const m of st.monsters) {
    // G_UseTargets reaches monster edicts by targetname: TRIGGER_SPAWN
    // bodies wake (monster_triggered_spawn_use), live others alert
    // (monster_use). Movers/trains/relays keep their branches below.
    if (!m.edict.freed && m.edict.targetname === user.target) SV_UseMonster(m, true, st);
  }
  let firedTrain = false;
  for (const e of st.entities) {
    if (e.freed || e.targetname !== user.target) continue;
    // C: doors never "use" their areaportal targets (see setDoorPortals).
    if (userIsDoor && e.classname === 'func_areaportal') continue;
    // Delayed relays schedule instead of firing (id trigger_relay_use runs
    // G_UseTargets on the relay itself): no firedThisTick push until the
    // think runs. Delays on other targets are consumed by their own logic
    // (target_explosion fuse delays ride the explosion table via
    // firedThisTick), never deferred here.
    if (e.classname === 'trigger_relay' && entDelay(e) > 0) {
      st.delayed.push({ at: st.time + entDelay(e), ent: stripDelayForThink(e), depth: depth + 1 });
      continue;
    }
    st.firedThisTick.push(e.targetname);
    if (e.classname === 'light') {
      // C light_use (g_misc.c:545): flip CS_LIGHTS+style between "m" (on)
      // and "a" (off). Only style>=32 lights install the use (SP_light
      // gate); the record persists for the render path and every firing
      // appends to the toggle log (strobe cadence observable).
      const style = Number.parseInt(e.extra['style'] ?? '', 10);
      if (Number.isFinite(style) && style >= 32) {
        const cur = st.lightStyles[style] ?? 'm';
        const next = cur === 'm' ? 'a' : 'm';
        st.lightStyles[style] = next;
        st.lightToggles.push({ style, value: next });
      }
      continue;
    }
    if (e.classname === 'target_help') {
      // C Use_Target_Help (g_target.c): spawnflags & 1 selects
      // game.helpmessage1, else game.helpmessage2; every firing bumps
      // game.helpchanged (the driver's pers.* ack lives outside this
      // package — see the ServerState help block). Unlike secrets/goals
      // this is NOT single-use: repeated firings re-latch + re-bump.
      if (e.spawnflags & 1) st.helpMessage1 = e.message;
      else st.helpMessage2 = e.message;
      st.helpChangedSeq++;
      continue;
    }
    if (e.classname === 'target_secret') {
      // C use_target_secret: single-use (G_FreeEdict) with the secret sound
      // (default misc/secret.wav), then G_UseTargets on itself — which prints
      // the secret's own message + talk1 (base1's t91/t77/t76 all carry one).
      // The loop skips freed edicts, so freeing here counts exactly once;
      // base1 secrets chain nowhere onward.
      e.freed = true;
      st.foundSecrets++;
      st.sounds.push({
        name: 'misc/secret.wav',
        pos: v3(e.origin[0], e.origin[1], e.origin[2]),
        born: st.time,
      });
      if (e.message) {
        st.centerprints.push(e.message);
        st.sounds.push({
          name: 'misc/talk1.wav',
          pos: v3(e.origin[0], e.origin[1], e.origin[2]),
          born: st.time,
        });
      }
      continue;
    }
    if (e.classname === 'target_goal') {
      // C use_target_goal: single-use count (+ G_UseTargets/G_FreeEdict;
      // no base1 goal chains onward, so no onward fire — documented).
      e.freed = true;
      st.foundGoals++;
      st.sounds.push({
        name: 'misc/secret.wav',
        pos: v3(e.origin[0], e.origin[1], e.origin[2]),
        born: st.time,
      });
      continue;
    }
    if (e.classname === 'target_splash') {
      // C use_target_splash (g_target.c): TE_SPLASH burst (count particles
      // along movedir, sounds-indexed color) + spark sound. Base1's 12
      // splashes are all sounds 1 (no dmg); a dmg splash would also run
      // T_RadiusDamage (MOD_SPLASH) — the use path carries no player/trace,
      // so that half is deferred (no base1 instance needs it).
      fireSplashTarget(st, e.targetname);
      continue;
    }
    if (e.classname === 'target_speaker') {
      // C Use_Target_Speaker (g_target.c): the looped pair (spawnflags & 3)
      // toggles ent->s.sound off/on — a persistent loop-channel entry here
      // (start = added, stop = removed, position = pos); one-shot noises play
      // positioned. Base1's *20 glass shatter (t78 -> world/brkglas.wav) is
      // one-shot; the 5 named looptoggles (t71/t72/t79/t80/t81) ride the
      // toggle half, driven by the func_timer cadence.
      for (const sp of st.speakers.get(e.targetname) ?? []) {
        if (sp.looped && sp.noise) {
          const at = st.sounds.findIndex(
            (s) =>
              s.loop === true &&
              s.name === sp.noise &&
              s.pos[0] === sp.origin[0] &&
              s.pos[1] === sp.origin[1] &&
              s.pos[2] === sp.origin[2],
          );
          if (at >= 0) st.sounds.splice(at, 1);
          else {
            st.sounds.push({
              name: sp.noise,
              pos: v3(sp.origin[0], sp.origin[1], sp.origin[2]),
              born: st.time,
              loop: true,
            });
          }
        } else if (!sp.looped && sp.noise) {
          st.sounds.push({
            name: sp.noise,
            pos: v3(sp.origin[0], sp.origin[1], sp.origin[2]),
            born: st.time,
          });
        }
      }
      continue;
    }
    if (e.classname === 'func_timer') {
      // C func_timer_use (g_func.c): toggles the cadence loop. Firing the
      // timer's own target runs through the same cascade (depth-guarded).
      for (const t of st.timers) {
        if (!t.ent.freed && t.ent === e) useTimer(st, t, depth + 1);
      }
      continue;
    }
    if (e.classname === 'target_changelevel') {
      // C use_target_changelevel -> BeginIntermission: SP exits immediately
      // (level.exitintermission = 1, no intermission screen outside DM/coop).
      // base2 is not shipped, so the stand-in is the finished screen.
      SV_FinishLevel(st, 'exit');
      continue;
    }
    const m = st.movers.find((mm) => mm.ent === e);
    if (m) {
      SV_UseMover(st, m, depth);
      continue;
    }
    const sm = st.secretDoors.find((s) => s.ent === e);
    if (sm) {
      // Secret use fires no targets (C door_secret_use skips G_UseTargets).
      secretUse(sm, st.time);
      continue;
    }
    const rm = st.rotDoors.find((r) => r.ent === e);
    if (rm) {
      SV_UseRotDoor(st, rm);
      continue;
    }
    if (e.classname === 'trigger_relay') {
      // id G_UseTargets uses the relay, which fires the relay's own target
      // (delay pre-checked at the loop top — this recursion is immediate).
      fireTargets(st, e, depth + 1);
    } else {
      const tr = st.trains.find((tt) => tt.ent === e);
      // func_train / misc_strogg_ship use (train_use / ship use).
      if (tr) {
        startTrain(tr, st.time);
        firedTrain = true;
      }
    }
  }
  if (user.classname === 'func_button' && firedTrain) {
    // End-of-level finish (base2-not-shipped stand-in, not C: C only exits
    // through target_changelevel). Only the one-way (wait -1, holds TOP)
    // lift-call button qualifies — base1's *13 (t91) starts the *12 exit
    // lift (and finds its secret).
    // RELEASE-4 aboard guard: boarding alone never finishes; pressing or
    // shooting the call button from outside starts the train (C-correct,
    // secret still found) but does NOT finish. Only activation while
    // standing on the exit train (driver-latched playerGroundEntity ==
    // train num) completes the level — repeated presses (TOP hold),
    // outside presses and unrelated triggers never finish. Base1 scope
    // note: the *12 slot is C-identical 16-wide (player hull 32), so
    // train-aboard is unreachable on foot in any engine — the reachable
    // elevator-button completion is the *31 plug lift below (t4, aboard
    // plug). The train guard stays (no outside finish) without claiming
    // a walkable train route.
    const btn = st.movers.find((mm) => mm.ent === user);
    if (btn && btn.wait < 0) {
      const aboard = st.trains.some(
        (tr) => !tr.ship && tr.started && tr.ent.num === st.playerGroundEntity,
      );
      if (aboard) SV_FinishLevel(st, 'lift');
    }
  }
  if (user.classname === 'func_button') {
    // RELEASE-4 plug elevator finish (documented departure, driver-gated):
    // base1's *34 (target t4) calls the *31 plug lift. The C-identical
    // *12 train slot is 16-wide (player hull 32) — unboardable in any
    // engine — while the open plug top is 140x208 at 88, boardable by a
    // 32 drop from the doorway slot (no world surgery, mover clip only).
    // Pressing *34 from the doorway face opens the plug (no finish, not
    // aboard); boarding the open plug alone never finishes; pressing *34
    // while standing on the plug (playerGroundEntity == *31 num) completes
    // the level (first-reason-wins, TOP/return timing unchanged, C movement
    // otherwise intact). Boarding is a 32u drop west off the face onto the
    // open top; the finishing press is an aimed E-use from aboard over the
    // lowered plug (west of the slider plane, so LOS never crosses the
    // *32/*33 sweeps). Unrelated triggers (t91 secret/train, t37 pit
    // exit) never finish here; outside *34 presses never finish.
    const btn = st.movers.find((mm) => mm.ent === user);
    if (btn && btn.ent.target === 't4') {
      const plug = st.movers.find((mm) => mm.ent.model === '*31');
      if (plug && st.playerGroundEntity === plug.ent.num) {
        SV_FinishLevel(st, 'lift');
      }
    }
  }
}

/** True when the edict is a brush-model trigger (model *N, no usable origin). */
function isBrushTrigger(e: Edict): boolean {
  return e.model.startsWith('*');
}

/** AABB overlap of a body box (origin + mins/maxs) with brush bounds. */
function bodyOverlapsBounds(
  origin: Vec3,
  mins: Vec3,
  maxs: Vec3,
  bmins: Float32Array,
  bmaxs: Float32Array,
): boolean {
  for (let i = 0; i < 3; i++) {
    if (origin[i]! + mins[i]! > bmaxs[i]! || origin[i]! + maxs[i]! < bmins[i]!) return false;
  }
  return true;
}

/**
 * Touch all triggers as `toucherClass` at the toucher's position.
 *
 * Brush triggers (model *N) are tested by real brush-VOLUME overlap: their
 * edict origin defaults to the world origin (0,0,0), so any point-proximity
 * test fires them spuriously whenever the player walks near (0,0,0) — in
 * base1 that walkable floor point sits ~344 units from spawn, and every
 * brush trigger (including the *27 exit-pit chain) fired there. Triggers
 * whose bounds were never registered (no modelSizes hook) are skipped
 * rather than fired by proximity: firing them would always be spurious.
 * Point triggers (no brush model) keep the legacy 96-unit proximity check.
 */
export function SV_TouchTriggersAt(
  st: ServerState,
  toucherClass: 'player' | 'monster',
  toucher: Edict,
): void {
  for (const t of st.triggers) {
    if (t.ent.freed) continue;
    if (isBrushTrigger(t.ent)) {
      const b = st.triggerBounds.get(t.ent.num);
      if (!b) continue;
      if (!bodyOverlapsBounds(toucher.origin, toucher.mins, toucher.maxs, b.mins, b.maxs)) continue;
    } else {
      // point trigger: proximity check around the edict origin
      const dx = toucher.origin[0]! - t.ent.origin[0]!;
      const dy = toucher.origin[1]! - t.ent.origin[1]!;
      const dz = toucher.origin[2]! - t.ent.origin[2]!;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 96 * 96) continue;
    }
    triggerTouch(t, st.time, toucherClass, (tt) => {
      const pseudo: Edict = { ...tt.ent };
      fireTargets(st, pseudo);
    });
  }
}

/**
 * Touch door trigger fields (id Touch_DoorTrigger, g_func.c): every func_door
 * (and func_door_rotating — SP_func_door_rotating installs the same think)
 * spawns one STATIC invisible trigger volume from its rest brush bounds
 * expanded 60 in x/y (Think_SpawnDoorTrigger). A body overlapping the volume
 * uses the door (door_use), exactly like the bot driver mirrors. Doors
 * without registered brush bounds (no modelSizes hook) are skipped.
 * func_door_secret spawns NO trigger in C, so secrets never open on touch.
 *
 * Two C-parity rules live here (both were violated before and produced the
 * exit-hall auto-cycle: the volume used to follow the moving door, and a
 * touch on a waiting door restarted its leg every tick):
 * - the volume is baked from the REST bounds and never follows the door. A
 *   follower volume strands a camper outside once the slab slides away, so
 *   the TOP wait expires, the door closes, re-touches, and cycles forever.
 * - a touch runs C door_go_up (doorTouchUse for sliders, rotUse for
 *   rotators): GOING_UP is a no-op, TOP/WAITING only resets the full wait
 *   (no leg restart, no target re-fire), BOTTOM — or DOWN mid-close —
 *   starts the UP leg and fires the door's target once.
 *
 * C gates (Touch_DoorTrigger): monsters never trip DOOR_NOMONSTER doors
 * (spawnflags & 8 — both base1 sliders carry it). C also debounces touches
 * at 1Hz; that only rate-limits redundant door_use calls (every touch here
 * is already idempotent or a one-shot leg start), so no debounce is kept.
 * Pass toucherClass 'monster' for monster bodies so the NOMONSTER gate
 * applies.
 *
 * C spawn rule (SP_func_door / SP_func_door_rotating): a door carrying
 * health or a targetname gets NO touch trigger at all (think =
 * Think_CalcMoveSpeed, not Think_SpawnDoorTrigger) — it answers use (a
 * button relay like base1's *34 -> t4, or damage) but never proximity.
 * Base1's *31 plug (targetname t4) is such a door: the entry-hall camper
 * overlapping its expanded rest bounds must NOT lower it; only the *34
 * press may. Skipping those movers here is that rule.
 *
 * Returns the doors that started moving (sliders and rotators).
 */
export function SV_TouchDoorsAt(
  st: ServerState,
  body: { origin: Vec3; mins: Vec3; maxs: Vec3 },
  toucherClass: 'player' | 'monster' = 'player',
): Array<Mover | RotMover> {
  const used: Array<Mover | RotMover> = [];
  for (const m of st.movers) {
    if (m.ent.classname !== 'func_door') continue;
    // id SP_func_door: health/targetname doors spawn no trigger (see above).
    if (m.ent.targetname || m.ent.health > 0) continue;
    // id Touch_DoorTrigger: NOMONSTER doors ignore monster touches.
    if (toucherClass === 'monster' && m.ent.spawnflags & DOOR_NOMONSTER) continue;
    const b = st.moverBounds.get(m.ent.num);
    if (!b) continue;
    // C Think_SpawnDoorTrigger bakes the trigger ONCE from the rest bounds
    // (unioned over the teamchain, +60 x/y) — it never follows the door.
    const tmins = new Float32Array([b.mins[0]! - 60, b.mins[1]! - 60, b.mins[2]!]);
    const tmaxs = new Float32Array([b.maxs[0]! + 60, b.maxs[1]! + 60, b.maxs[2]!]);
    if (!bodyOverlapsBounds(body.origin, body.mins, body.maxs, tmins, tmaxs)) continue;
    // C door_use → door_go_up: opens (firing the door's own target as the
    // leg starts), holds TOP open, or reverses a close — never restarts.
    // A fresh leg plays sound_start (door_go_up/down) and opens portals.
    const res = doorTouchUse(m, st.time);
    if (res === 'opened') {
      doorLegStartSound(st, m);
      if (m.ent.target) fireTargets(st, m.ent, 1);
      setDoorPortals(st, m.ent, true);
      used.push(m);
    } else if (res === 'closed') {
      doorLegStartSound(st, m);
      used.push(m);
    }
  }
  for (const rm of st.rotDoors) {
    // id SP_func_door_rotating: same no-trigger rule as linear doors.
    if (rm.ent.targetname || rm.ent.health > 0) continue;
    if (toucherClass === 'monster' && rm.ent.spawnflags & DOOR_NOMONSTER) continue;
    const b = st.moverBounds.get(rm.ent.num);
    if (!b) continue;
    // Rotating doors never translate, so the rest bounds apply unoffset
    // (the swing itself is ignored — bounds-exact rotation needs the brush
    // planes; the 60-unit touch slop covers ordinary swings).
    const tmins = new Float32Array([b.mins[0]! - 60, b.mins[1]! - 60, b.mins[2]!]);
    const tmaxs = new Float32Array([b.maxs[0]! + 60, b.maxs[1]! + 60, b.maxs[2]!]);
    if (!bodyOverlapsBounds(body.origin, body.mins, body.maxs, tmins, tmaxs)) continue;
    // door_use → door_go_up (angular): opens (firing the target as the leg
    // starts, like sliders), holds TOP open, TOGGLE closes. rotUse already
    // encodes all of that, so TOP bodies reach it too.
    const res = SV_UseRotDoor(st, rm);
    if (res !== null) used.push(rm);
  }
  return used;
}

/**
 * Touch func_button brushes (id button_touch, g_func.c): a live player body
 * overlapping the button's CURRENT brush box (it travels a few units when
 * pressed) presses it — C button_fire, which is a no-op while the button
 * is already UP or holding TOP. Only touchable buttons answer touch
 * (SP_func_button installs touch solely when the button carries no
 * targetname and no health — remote/health buttons answer use only), only
 * clients press (monsters never trip buttons), and dead players press
 * nothing. Buttons without registered brush bounds are skipped.
 *
 * Returns the buttons that started moving.
 */
export function SV_TouchButtonsAt(
  st: ServerState,
  body: { origin: Vec3; mins: Vec3; maxs: Vec3 },
  toucherClass: 'player' | 'monster' = 'player',
): Mover[] {
  const used: Mover[] = [];
  if (toucherClass !== 'player') return used;
  if (st.playerHealth <= 0) return used;
  for (const m of st.movers) {
    if (m.ent.classname !== 'func_button' || m.ent.freed) continue;
    if (!isButtonTouchable(m.ent)) continue;
    const box = SV_MoverClipBox(st, m);
    if (!box) continue;
    // Contact presses (C G_TouchTriggers fires on the blocking clip): the
    // lean rest sits 1/32 off the face, so test the box grown by
    // BUTTON_TOUCH_SLOP instead of the exact brush.
    const s = BUTTON_TOUCH_SLOP;
    const tmins = new Float32Array([box.mins[0]! - s, box.mins[1]! - s, box.mins[2]! - s]);
    const tmaxs = new Float32Array([box.maxs[0]! + s, box.maxs[1]! + s, box.maxs[2]! + s]);
    if (!bodyOverlapsBounds(body.origin, body.mins, body.maxs, tmins, tmaxs)) continue;
    // C button_fire: UP/TOP presses are no-ops (no leg restart, and — unlike
    // doors — no target re-fire until the button returns to BOTTOM).
    if (!buttonCanFire(m)) continue;
    SV_UseMover(st, m);
    used.push(m);
  }
  return used;
}

/**
 * E-use a func_button (driver `use` key): press the AIMED button within
 * reach inside the facing cone — C button_use semantics (button_fire gate:
 * UP/TOP no-op, wait/-1 holds TOP) with the button's own touch rules for
 * health/targetname untouched (use answers any live button, like C).
 * A zero-hull eye→center trace rejects presses through walls (the button's
 * own brush reports the button's edict num and passes); without a trace
 * hook the reach+facing gates alone decide. Only the aimed (nearest)
 * button fires — firing one button never fans out to other targetnames.
 *
 * Returns the pressed button, or null when nothing was in reach/aim (or a
 * wall stood between, or the aimed button was already UP/TOP).
 */
export function SV_UseButton(
  st: ServerState,
  eye: Vec3,
  fwd: Vec3,
  opts?: { trace?: TraceFn; reach?: number; dot?: number },
): Mover | null {
  const centers: Array<{ m: Mover; center: Vec3 }> = [];
  for (const m of st.movers) {
    if (m.ent.classname !== 'func_button' || m.ent.freed) continue;
    // SV_MoverClipBox already returns the CURRENT (travelled) box, so the
    // center needs no extra offset.
    const box = SV_MoverClipBox(st, m);
    if (!box) continue;
    centers.push({ m, center: displacedCenter(box, v3(0, 0, 0)) });
  }
  const m = selectUseButton(
    centers,
    eye,
    fwd,
    opts?.reach ?? BUTTON_USE_REACH,
    opts?.dot ?? BUTTON_USE_DOT,
  );
  if (!m) return null;
  if (opts?.trace) {
    const box = SV_MoverClipBox(st, m);
    if (!box) return null;
    const center = displacedCenter(box, v3(0, 0, 0));
    const t = opts.trace(eye, ZERO_HULL, ZERO_HULL, center);
    // The button's own brush owns the trace end (the trace runs inside it);
    // any other stop short of the center is a wall between eye and button.
    if (t.entityNum !== m.ent.num && t.fraction < 1) return null;
  }
  if (!buttonCanFire(m)) return null;
  SV_UseMover(st, m);
  return m;
}

// --- monster tick (game/g_ai.c M_CheckAttack + m_move.c locomotion) -----------

export interface MonsterEvent {
  /** edict num of the firing monster */
  num: number;
  classname: string;
  /** lite attack choice (selectAttack / move mapping in @q2/game) */
  attack: AttackChoice;
  /** data-table move playing (attack1/attack_chain/runandshoot/...) */
  move: string;
  /** damage-to-player scale at this skill (g_combat.c easy half) */
  dmgScale: number;
  /** move-frame index that just played (fire-tagged; grenades leave the tube
   * only on the C frames — the resolver gates on this, like monsterFire). */
  frame: number;
}

const POINT_HULL: Vec3 = v3(0, 0, 0);

/**
 * C visible() (g_ai.c): eye-to-eye point trace — self origin + viewheight
 * (25 for walkmonsters, g_monster.c) to other origin + its viewheight —
 * against MASK_OPAQUE. Knee-to-knee origin traces stay blocked behind low
 * rails and stair lips the eyes clear, which wedges ambush monsters in
 * stand forever; the +25/+22 offsets are the fix. The C sight mask ignores
 * WINDOW, so glass never blocks C sight: pass an opaque-mask trace via
 * MonsterTickOpts when glass sits between the bodies, otherwise the shared
 * move trace doubles (glass then blocks sight — the one known deviation).
 */
function losClear(
  sightTrace: TraceFn,
  selfPos: Vec3,
  playerPos: Vec3,
  playerView: number,
): boolean {
  const a = v3(selfPos[0], selfPos[1], selfPos[2]! + MONSTER_VIEWHEIGHT);
  const b = v3(playerPos[0], playerPos[1], playerPos[2]! + playerView);
  const t = sightTrace(a, POINT_HULL, POINT_HULL, b);
  return t.fraction === 1 && !t.startsolid;
}

/**
 * C SV_movestep stair climb (m_move.c, STEPSIZE 18) wrapped around the
 * locomotion hull trace: when the straight move clips, lift one step, move,
 * and drop two steps, keeping the stepped landing when it lands on ground
 * and travels farther than the direct clip. Without this any riser wedges
 * the hull and uphill pursuit stalls at the stair base forever. Vertical
 * probes (the gravity leg) pass through untouched — stepping applies only
 * to horizontal moves. M_CheckBottom's dangling-corner veto is omitted;
 * the drop must land (fraction < 1) or the step is rejected.
 *
 * `maxs` is the caller's hull top (ducking soldiers shrink to the C duck
 * hull via monsterHullMaxs — a standing hull mid-duck wedges under gaps
 * the C duck passes); mins never change (C soldier_duck_down only lowers
 * maxs[2]).
 */
function stepHullTrace(
  trace: TraceFn,
  start: Vec3,
  end: Vec3,
  maxs: Vec3 = MONSTER_HULL_MAXS,
): { fraction: number; endpos: Vec3 } {
  const direct = trace(start, MONSTER_HULL_MINS, maxs, end);
  if (direct.fraction === 1 || direct.allsolid) {
    return { fraction: direct.fraction, endpos: direct.endpos };
  }
  if (Math.abs(end[2]! - start[2]!) > 1e-9) {
    return { fraction: direct.fraction, endpos: direct.endpos };
  }
  const sUp = v3(start[0], start[1], start[2]! + MONSTER_STEP_HEIGHT);
  const eUp = v3(end[0], end[1], end[2]! + MONSTER_STEP_HEIGHT);
  const up = trace(sUp, MONSTER_HULL_MINS, maxs, eUp);
  if (up.allsolid || up.startsolid) return { fraction: direct.fraction, endpos: direct.endpos };
  const down = trace(
    up.endpos,
    MONSTER_HULL_MINS,
    maxs,
    v3(up.endpos[0], up.endpos[1], up.endpos[2]! - 2 * MONSTER_STEP_HEIGHT),
  );
  if (down.allsolid || down.fraction === 1) return { fraction: direct.fraction, endpos: direct.endpos };
  const step2 =
    (down.endpos[0]! - start[0]!) * (down.endpos[0]! - start[0]!) +
    (down.endpos[1]! - start[1]!) * (down.endpos[1]! - start[1]!);
  const direct2 =
    (direct.endpos[0]! - start[0]!) * (direct.endpos[0]! - start[0]!) +
    (direct.endpos[1]! - start[1]!) * (direct.endpos[1]! - start[1]!);
  if (step2 <= direct2 + 1e-6) return { fraction: direct.fraction, endpos: direct.endpos };
  return { fraction: 1, endpos: down.endpos };
}

/** Inverse of attackMoveFor for the firing event (melee resolved by range). */
function attackOfMove(kind: MonsterKind, move: string): AttackChoice {
  switch (move) {
    case 'attack1':
      // Soldier attack1 is the shotgun strafe; infantry attack1 is the
      // machinegun strafe (m_infantry.c attack1 = InfantryMachineGun).
      return kind === 'infantry' ? 'machinegun' : 'shotgun';
    case 'attack2':
      // Soldier attack2 is the blaster/shotgun volley; infantry attack2 is
      // the melee smack (m_infantry.c attack2 = infantry_smack).
      return kind === 'infantry' ? 'melee' : 'blaster';
    case 'attack4':
      // ss soldier machinegun strafe (m_soldier.c soldier_move_attack4:
      // soldier_fire4, one 2dmg bullet per hold tick).
      return 'machinegun';
    case 'attack_chain':
    case 'fire_chain':
    case 'endfire_chain':
    case 'runandshoot':
      return 'chaingun';
    case 'attack_grenade':
      return 'grenade';
    default:
      return kind === 'soldier' ? 'blaster' : 'chaingun';
  }
}

/**
 * One 10Hz monster tick for every spawned monster (the M7.2 driver runs the
 * same @q2/game primitives in apps/web; this is the server-authoritative
 * equivalent used by tests and headless sims):
 * - triggered (spawnflags & 2) and unmapped (no lite def) monsters stay
 *   dormant;
 * - ambush (spawnflags & 1) monsters hold their stand pose until gated
 *   sight latches `seen` — the base1 opener: the start-room soldier waits
 *   until the player rounds the corner, then runs at them. Sight is C
 *   visible(): eye to eye (monster +25, player +22 standing) against an
 *   opaque-mask trace, gated by the C FindTarget range/infront rules (melee
 *   sees behind, near needs facing or a shot in the last second, mid needs
 *   facing, far never). Damage and gunfire noise acquire separately;
 * - target→path_corner monsters walk their patrol beat (ai_walk on
 *   movetarget, chained by targetname) while unseen instead of beelining;
 * - first sight latches seen plus the skill-scaled sight delay
 *   (HuntTarget AttackFinished): no attack may start before reactionAt;
 * - dying bodies slide through their death move and keep blocking until the
 *   last frame latches deadDone (C SVF_DEADMONSTER endfunc timing); settled
 *   corpses never block but stay hittable; gibbed bodies are gone;
 * - first sight latches seen plus the skill-scaled sight delay
 *   (HuntTarget AttackFinished): no attack may start before reactionAt;
 * - a monster carrying combattarget heads for its point_combat instead
 *   (one-shot hookup, chain/hold on arrival — no firing while en route);
 * - otherwise monsterChaseMove selects attack vs. close-in (C M_CheckAttack
 *   chance/as-state table, not the old flat roll), steering at the
 *   trail-pursuit goal when sight is lost (needs a nav graph; null builds
 *   a trivial two-node graph, i.e. straight steering). monsterLocomotion
 *   steps the body with a C SV_movestep stair-climbing hull trace plus
 *   gravity, and monsterThink advances the frame;
 * - every 'fire'/'melee' frame with line of sight emits a MonsterEvent
 *   carrying the skill damage scale, so drivers land shots on the muzzle
 *   flash (infantry's smack tags 'melee', everything ballistic tags 'fire').
 *   Duck-and-shoot (attack3) emits one skin-gun event mid-duck; the
 *   sustained-fire holds (ss attack4 0.3-1.0s, infantry attack1 1.0-2.5s
 *   with the infatck3 cock) freeze their fire frame and re-emit every
 *   10Hz tick until the pausetime runs out; skill-3 re-attacks may
 *   refire a finished attack1/attack2 immediately (attack1/2 nextframe).
 */
export interface MonsterTickOpts {
  /** Eye height of the player body (22 standing, 12 ducked, pmove.c). */
  playerViewheight?: number;
  /**
   * Sight trace for the visible() check (C runs MASK_OPAQUE, which ignores
   * WINDOW so glass never blocks monster sight). Defaults to the move trace;
   * pass SV_TraceFor(map, MASK_OPAQUE_C) when glass sits between bodies.
   */
  sightTrace?: TraceFn;
  /**
   * Player hull for C MASK_MONSTERSOLID movement blocking (sv_world.c
   * SV_ClipMoveToEntities clips every SOLID_BBOX except DEADMONSTER, so
   * walkers stop on the player instead of entering them). pos comes from
   * the playerPos arg; pass the hull here so the per-monster move trace
   * also clips the player box. Absent keeps the legacy world-only move.
   * SV_GameTick always passes it.
   */
  playerBody?: { mins: Vec3; maxs: Vec3 };
}

export function SV_MonsterTick(
  st: ServerState,
  playerPos: Vec3,
  trace: TraceFn,
  nav: MonsterNav | null,
  rand: () => number,
  opts?: MonsterTickOpts,
): MonsterEvent[] {
  const events: MonsterEvent[] = [];
  const sightTrace = opts?.sightTrace ?? trace;
  const playerView = opts?.playerViewheight ?? PLAYER_VIEWHEIGHT;
  const now = st.time;
  // Per-monster move trace (C g_phys.c SV_Move + server/sv_world.c
  // SV_ClipMoveToEntities): the world/clip trace PLUS every OTHER live
  // monster hull (self skipped via ignoreNum — a mover always starts inside
  // its own hull) PLUS the player box, so walkers stop on bodies instead
  // of entering them. Settled corpses never block (C SVF_DEADMONSTER skip
  // without CONTENTS_DEADMONSTER — SV_MonsterClipBox drops them the same
  // way); dying bodies still clip until deadDone latches. Gibbed/dormant
  // bodies are already skipped there. The player box always
  // clips while provided (C keeps the client edict SOLID_BBOX after death;
  // SP restarts on death anyway). Sight still runs on sightTrace.
  let playerMins: Float32Array | null = null;
  let playerMaxs: Float32Array | null = null;
  if (opts?.playerBody) {
    playerMins = new Float32Array([
      playerPos[0]! + opts.playerBody.mins[0]!,
      playerPos[1]! + opts.playerBody.mins[1]!,
      playerPos[2]! + opts.playerBody.mins[2]!,
    ]);
    playerMaxs = new Float32Array([
      playerPos[0]! + opts.playerBody.maxs[0]!,
      playerPos[1]! + opts.playerBody.maxs[1]!,
      playerPos[2]! + opts.playerBody.maxs[2]!,
    ]);
  }
  const moveTraceFor = (self: ServerMonster): TraceFn => {
    const base = SV_ClipTrace(st, trace, self.edict.num, true);
    if (!playerMins || !playerMaxs) return base;
    const pmins = playerMins;
    const pmaxs = playerMaxs;
    return (s: Vec3, mins: Vec3, maxs: Vec3, e: Vec3) => {
      const best = base(s, mins, maxs, e);
      const hit = sweepBrushBox(s, e, mins, maxs, pmins, pmaxs);
      if (hit.allsolid || hit.fraction < best.fraction) {
        return {
          fraction: hit.fraction,
          endpos: v3(
            s[0]! + (e[0]! - s[0]!) * hit.fraction,
            s[1]! + (e[1]! - s[1]!) * hit.fraction,
            s[2]! + (e[2]! - s[2]!) * hit.fraction,
          ),
          planeNormal: hit.normal,
          allsolid: hit.allsolid,
          startsolid: hit.startsolid,
          entityNum: best.entityNum,
          contents: best.contents,
          surfaceFlags: best.surfaceFlags,
        };
      }
      return best;
    };
  };
  // Player-trail upkeep (p_client.c): record the spot when it leaves sight
  // of the last marker, so blind pursuit follows the path, not a beeline.
  // Lives here (not just SV_GameTick) so direct-tick callers get the same
  // populated trail the production tick thinks with — pursuit keys off it,
  // and an empty trail degenerates to the world origin. Idempotent: a fresh
  // marker is already visible, so a second call per tick adds nothing.
  trailUpkeep(
    st,
    playerPos,
    v3(playerPos[0], playerPos[1], playerPos[2]! + playerView),
    sightTrace,
    st.playerHealth > 0,
  );
  for (const m of st.monsters) {
    if (m.kind === null || (m.triggered && !m.woken)) continue;
    const ms: MonsterState = m.state;
    if (ms.gibbed) continue;
    if (ms.dead) {
      // Dying bodies keep sliding through their death move (id ai_move runs
      // inside every death frame until the endfunc) and keep blocking
      // movement until deadDone latches (SVF_DEADMONSTER timing) — only
      // then does the hull drop (soldier_dead / infantry_dead linkentity).
      // Last-ditch shots (soldier death1 fire frames, infantry death2
      // spray) emit skin-gun events through the live resolver, exactly like
      // duck-and-shoot. Unconditional like C (no LOS gate).
      if (!ms.deadDone) {
        const moveTrace = moveTraceFor(m);
        monsterLocomotion(ms, m.edict.origin, playerPos, (s, e) => {
          const h = stepHullTrace(moveTrace, s, e, monsterHullMaxs(m));
          return { fraction: h.fraction, endpos: h.endpos };
        });
      } else if (m.edict.solid !== SOLID_NOT) {
        m.edict.solid = SOLID_NOT;
      }
      const deadAction = monsterThink(ms);
      // The endfunc lands inside monsterThink (deadDone latches on the last
      // frame): drop the hull the same tick, so a corpse never blocks for
      // an extra quantum after its fall completes.
      if (ms.deadDone && m.edict.solid !== SOLID_NOT) m.edict.solid = SOLID_NOT;
      const lastDitch = deathFireEvent(m, deadAction, skillMultiplier(st.skill));
      if (lastDitch) events.push(lastDitch);
      continue;
    }
    // Woken bodies stamp their sight delay against the clock (SV_UseMonster
    // carries no time, so the use only parks -1).
    if (m.reactionAt < 0) m.reactionAt = reactionAt(st.skill, now);
    // Body-aware move trace for this monster (world/clips + other live
    // monsters + the live player box, self skipped): steering probes and
    // locomotion share it, so pursuit rounds bodies instead of entering
    // them. Sight still runs on sightTrace.
    const moveTrace = moveTraceFor(m);
    const pos = m.edict.origin;
    const dx = playerPos[0]! - pos[0]!;
    const dy = playerPos[1]! - pos[1]!;
    const dz = playerPos[2]! - pos[2]!;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const los = losClear(sightTrace, pos, playerPos, playerView);
    // C FindTarget vision gating (g_ai.c): visible() alone never acquires —
    // melee range (< 80) sees even behind, near (< 500) needs facing unless
    // the player fired in the last second (show_hostile), mid (< 1000)
    // needs facing, far never acquires. Damage and noise acquire separately.
    const hostile = now - st.lastPlayerShotAt < 1;
    const spotted = !m.seen && acquireSight(m, playerPos, dist, los, hostile);
    // FoundTarget (g_ai.c): first sight acquires the enemy plus the
    // sight-delay hold (HuntTarget AttackFinished) before any attack.
    if (spotted) {
      m.seen = true;
      m.reactionAt = reactionAt(st.skill, now);
    }
    if (m.ambush && !m.seen && !m.patrolCorner) {
      // Ambush stand (ai_stand without movetarget): hold the pose until
      // gated sight acquires. Beat cops skip this: C ai_walk steps the
      // movetarget FIRST and checks FindTarget after, so patrolling
      // ambushers keep walking while unseen (the patrol branch below runs
      // the same gated acquisition before stepping).
      if (!los || !acquireSight(m, playerPos, dist, true, hostile)) {
        const stand = m.kind === 'soldier' ? 'stand1' : 'stand';
        if (ms.move !== stand) {
          ms.move = stand;
          ms.frame = 0;
        }
        monsterThink(ms);
        continue;
      }
      m.seen = true;
      m.reactionAt = reactionAt(st.skill, now);
    }
    // Patrol beat (ai_walk on movetarget): unseen beat cops walk their
    // corners — facing and stepping along the route — instead of beelining
    // the player. Acquisition above already latched seen (hunt from here);
    // arrival advances the targetname chain (loops run forever), an ended
    // chain stands, and wait corners hold the stand pose. Corner waits and
    // arrivals below run on the same gated sight (ai_walk checks FindTarget
    // every frame, which already ran). C path_corner_touch order: fire the
    // arrived corner's pathtarget, resolve + teleport through the next link,
    // install movetarget, then stand out the ARRIVED corner's own wait.
    if (!m.seen && m.patrolCorner && m.patrolGoal) {
      if (now < m.patrolWaitUntil) {
        const stand = m.kind === 'soldier' ? 'stand1' : 'stand';
        if (ms.move !== stand) {
          ms.move = stand;
          ms.frame = 0;
        }
        monsterThink(ms);
        continue;
      }
      const gx = m.patrolGoal[0]! - pos[0]!;
      const gy = m.patrolGoal[1]! - pos[1]!;
      if (Math.hypot(gx, gy) <= 24) {
        const corners = patrolCornersOf(st);
        const arrivedName = m.patrolCorner;
        const arrival = arrivePatrol(corners, arrivedName);
        if (!arrival) {
          m.patrolCorner = '';
          m.patrolGoal = null;
          const stand = m.kind === 'soldier' ? 'stand1' : 'stand';
          ms.move = stand;
          ms.frame = 0;
          monsterThink(ms);
          continue;
        }
        if (arrival.fire) fireTargets(st, { ...m.edict, target: arrival.fire });
        if (arrival.teleported && arrival.teleportPos) {
          // C TELEPORT corner: snap to the teleport (corner mins -8 above the
          // monster hull mins -24 puts z +16), chain through to its target.
          // No travel leg to the teleport itself. (C also flags s.event; the
          // lite sim has no teleport event channel — the origin snap is the
          // observable.) In-place: the tick's `pos` alias must see the snap
          // for the walk leg below (C VectorCopy into other->s.origin).
          m.edict.origin[0] = arrival.teleportPos[0]!;
          m.edict.origin[1] = arrival.teleportPos[1]!;
          m.edict.origin[2] = arrival.teleportPos[2]! + 16;
          m.slideDir = 0;
        }
        if (arrival.wait > 0) {
          // C installs movetarget (the NEXT corner) before the wait check, so
          // the leg is already armed while the body stands out the ARRIVED
          // corner's own wait (self->wait, never the next corner's).
          if (arrival.next) {
            m.patrolCorner = arrival.next.name;
            m.patrolGoal = v3(arrival.next.pos[0], arrival.next.pos[1], arrival.next.pos[2]);
          } else {
            m.patrolCorner = '';
            m.patrolGoal = null;
          }
          m.patrolWaitUntil = now + arrival.wait;
          const stand = m.kind === 'soldier' ? 'stand1' : 'stand';
          ms.move = stand;
          ms.frame = 0;
          monsterThink(ms);
          continue;
        }
        if (!arrival.next) {
          m.patrolCorner = '';
          m.patrolGoal = null;
          const stand = m.kind === 'soldier' ? 'stand1' : 'stand';
          ms.move = stand;
          ms.frame = 0;
          monsterThink(ms);
          continue;
        }
        m.patrolCorner = arrival.next.name;
        m.patrolGoal = v3(arrival.next.pos[0], arrival.next.pos[1], arrival.next.pos[2]);
      }
      const walk = patrolWalkMove(m.kind);
      if (ms.move !== walk) {
        ms.move = walk;
        ms.frame = 0;
      }
      const goal = m.patrolGoal;
      monsterLocomotion(ms, pos, playerPos, (s, e) => {
        const h = stepHullTrace(moveTrace, s, e, monsterHullMaxs(m));
        return { fraction: h.fraction, endpos: h.endpos };
      }, goal, { newChaseDir: true, slideSign: m.slideDir });
      monsterThink(ms);
      continue;
    }
    // Combat-point hookup (one-shot): a carried combattarget installs the
    // point_combat goal instead of hunting the enemy directly.
    if (m.seen) resolveCombatPoint(st, m);
    // Steering goal: combat points run blind (M_MoveToGoal, no attack);
    // seen monsters pursue via the trail when sight breaks; unseen beat-less
    // non-ambush bodies stand (C ai_stand with pausetime 1e8 — no target, no
    // movetarget) instead of beelining: with patrol beats and the noise path
    // in place the legacy beeline would walk standers into the player.
    if (!m.seen && !m.combatGoal && !m.combatHold) {
      const stand = m.kind === 'soldier' ? 'stand1' : 'stand';
      if (ms.move !== stand) {
        ms.move = stand;
        ms.frame = 0;
      }
      monsterThink(ms);
      continue;
    }
    let standGround = false;
    let goal: Vec3;
    if (m.combatGoal) {
      if (dist3(pos, m.combatGoal) <= 24) {
        const pathtarget = arriveCombatPoint(st, m);
        if (pathtarget) fireTargets(st, { ...m.edict, target: pathtarget });
      }
      if (m.combatGoal) {
        goal = m.combatGoal;
      } else if (m.combatHold) {
        standGround = true;
        goal = m.seen ? pursueGoal(st, m, playerPos, los, sightTrace, frameDistOf(ms), moveTrace) : playerPos;
      } else {
        goal = m.seen ? pursueGoal(st, m, playerPos, los, sightTrace, frameDistOf(ms), moveTrace) : playerPos;
      }
    } else {
      if (m.combatHold) standGround = true;
      goal = m.seen
        ? pursueGoal(st, m, playerPos, los, sightTrace, frameDistOf(ms), moveTrace)
        : playerPos;
      goal = separationOffset(st, m, goal);
    }
    const navEff: MonsterNav =
      nav ??
      {
        graph: new Map<number, number[]>([
          [0, [1]],
          [1, [0]],
        ]),
        positions: new Map<number, Vec3>([
          [0, v3(pos[0], pos[1], pos[2])],
          [1, v3(goal[0], goal[1], goal[2])],
        ]),
      };
    // Sight delay (HuntTarget AttackFinished): attacks stay holstered until
    // reactionAt, but the body still closes — folded into the sight bit so
    // monsterChaseMove's M_CheckAttack path never sees an early attack.
    const gated = los && now >= m.reactionAt;
    // A playing duck is never interrupted (C runs the current move's
    // frames): chase decisions would re-roll it into run/attack, so the
    // duck steers with the goal but takes no chase decisions until it
    // finishes. Think + locomotion below still advance it.
    // A live sustained-fire hold owns the body like a playing duck (C
    // M_MoveFrame freezes the frame and re-runs the thinkfunc; ai_run
    // movement continues via locomotion below, but no new attack decision
    // is rolled mid-hold — otherwise M_CheckAttack's cooldown would
    // re-roll the frozen fire frame into run after one round and the
    // 4–11 round burst would die at one bullet). Live = flag set on the
    // fire frame (covers the expiry tick too, so the C expiry bullet
    // fires before the frame advances); a stranded flag is cleared by the
    // range check below.
    const holdLive = m.burstHeld && sustainedFireFrame(m.kind, ms.move, ms.frame);
    if (ms.move !== 'duck' && !holdLive) {
      monsterChaseMove(ms, pos, playerPos, navEff, m.combatGoal ? false : gated, rand, {
        time: now,
        skill: st.skill,
        // Hold plants (see the stand-ground branch); combat runs steer blind
        // and never consider attacks, so they keep walking the point chain.
        standGround: standGround && m.combatGoal === null,
        goal,
        // Skin-keyed attack pick (C soldier_attack): ss skins commit to
        // the attack4 machinegun strafe.
        skin: skinOf(m),
      });
    }
    const loco = monsterLocomotion(ms, pos, playerPos, (s, e) => {
      const h = stepHullTrace(moveTrace, s, e, monsterHullMaxs(m));
      return { fraction: h.fraction, endpos: h.endpos };
    }, goal, { newChaseDir: true, slideSign: m.slideDir, frozen: holdLive });
    // Commit the sweep's hand: a sliding body keeps sliding the same way
    // (deterministic wall-following). Cleared direct legs do NOT drop it —
    // near a face a full step can fit without touching, and resetting there
    // re-decides with the default order every other tick (the dither the
    // hand exists to prevent). Sight regained drops it (see pursueGoal);
    // a wrong hand on a new wall self-corrects within one sweep.
    if (loco.slide !== 0) m.slideDir = loco.slide;
    const prevMove = ms.move;
    const playedIdx = ms.frame;
    // C AI_HOLD_FRAME careers on the monster as two fields: the gun
    // pausetime (burstUntil) and the flag itself (burstHeld). A set flag
    // freezes the fire frame and re-runs its thinkfunc every tick
    // (M_MoveFrame skips the frame++); the thinkfunc clears the flag once
    // the pausetime lapses, firing once more that tick (the C expiry
    // bullet) before the frame advances. wasHeld is the tick-start flag
    // on the hold frame: it tells a fresh arrival (arm) from the expiry
    // replay (advance without re-arming) — the pausetime alone cannot.
    // C M_MoveFrame range check: leaving the move (duck dodge, pain,
    // death) clears AI_HOLD_FRAME — a stranded flag must never eat a
    // fresh burst, and only a set flag on its fire frame may freeze.
    if (m.burstHeld && !sustainedFireFrame(m.kind, ms.move, ms.frame)) m.burstHeld = false;
    const wasHeld = m.burstHeld && sustainedFireFrame(m.kind, prevMove, playedIdx);
    let action: string;
    let advanced = false;
    if (duckHoldFrozen(m, now)) action = 'move';
    else if (burstHoldFrozen(m, now)) action = 'fire'; // live hold: frozen replay
    else {
      if (wasHeld) m.burstHeld = false; // lapsed hold: the flag clears
      action = monsterThink(ms); // fresh arrival AND expiry replay advance
      advanced = true;
    }
    // Skill-3 burst refire (attack1/attack2 nextframe): re-enter
    // the finished attack move immediately, bypassing the cooldown.
    // (attack4 has no nextframe in C — the hold IS the burst.)
    maybeBurstRefire(m, prevMove, los, st.skill, rand);
    // Duck-and-shoot (attack3): one skin-gun event on the duck fire frame.
    const duckEv = duckShootEvent(m, los, skillMultiplier(st.skill));
    if (duckEv) events.push(duckEv);
    // Infantry chaingun spin (m_infantry.c infantry_cock_gun, attak104):
    // the cock frame plays infatck3 and arms the 1.0-2.5s burst pausetime
    // (no bullet — the fire frame does that). Anim-committed like C: the
    // move was entered with LOS, so the cock always plays. The melee
    // wind-up (m_infantry.c infantry_swing, attak203) plays infatck2 the
    // same way — no damage, just the C cue the smack test pins.
    if (action === 'cock') {
      armInfantryCock(m, now, rand);
      st.sounds.push({
        name: INFANTRY_COCK_SOUND,
        pos: v3(pos[0], pos[1], pos[2]! + 32),
        born: st.time,
      });
    } else if (action === 'swing' && m.kind === 'infantry') {
      st.sounds.push({
        name: INFANTRY_SWING_SOUND,
        pos: v3(pos[0], pos[1], pos[2]! + 32),
        born: st.time,
      });
    }
    if ((action === 'fire' || action === 'melee') && los) {
      // Fresh arrival on the ss fire frame (a live hold's frozen replay
      // never reaches think; the expiry replay carries wasHeld): arm the C
      // pausetime (m_soldier.c soldier_fire sets it when AI_HOLD_FRAME is
      // clear). A fresh arrival overwrites any stale pausetime, like C.
      if (advanced && !wasHeld && m.kind === 'soldier' && ms.move === 'attack4') {
        armSoldierBurst(m, now, rand);
      }
      // Engaging a live hold latches the flag (infantry: the cock armed
      // the pausetime; the flag engages on the first fire — the hold then
      // freezes until the pausetime lapses).
      if (advanced && !wasHeld && sustainedFireFrame(m.kind, ms.move, playedIdx) && m.burstUntil > now) {
        m.burstHeld = true;
      }
      // Live hold: rewind the lite post-increment so M_MoveFrame re-fires
      // the frozen frame next tick. The expiry replay does not rewind:
      // the flag cleared, so the frame advances.
      if (m.burstHeld && m.burstUntil > now && sustainedFireFrame(m.kind, ms.move, playedIdx)) ms.frame = playedIdx;
      events.push({
        num: m.edict.num,
        classname: m.edict.classname,
        attack: dist < 80 ? 'melee' : attackOfMove(m.kind, ms.move),
        move: ms.move,
        dmgScale: skillMultiplier(st.skill),
        frame: playedIdx,
      });
    }
  }
  return events;
}

/** 3D distance between two points (arrival tests). */
function dist3(a: Vec3, b: Vec3): number {
  const dx = a[0]! - b[0]!;
  const dy = a[1]! - b[1]!;
  const dz = a[2]! - b[2]!;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Current frame's travel (for the pursuit arrival latch). */
function frameDistOf(ms: MonsterState): number {
  const mv = monsterMoveOf(ms);
  return mv.frames[ms.frame]?.dist ?? 0;
}

/**
 * Advance the world by dt seconds (default SERVER_DT = 0.1, 10Hz).
 * Runs movers and trains to completion legs, records per-mover displacement
 * for rider carrying, respawns due pickups, and clears per-tick diagnostics.
 *
 * Phase 0 single sim: `game` carries the live player body + world trace so
 * the tick also runs the gameplay phase — monster think with C cadence
 * fire resolution (melee/hitscan/foe-bolt damage, tracers, muzzles,
 * sounds), bolt flight + touch, barrel fuses, scripted explosions,
 * debris/gibs and explosion pruning, plus monster door touches. Absent
 * (headless/unit use), the tick stays movers+trains+respawn only.
 */
export function SV_Tick(st: ServerState, dt: number = SERVER_DT, game?: SVGameTick): void {
  st.firedThisTick = [];
  st.time += dt;
  const now = st.time;
  // DelayedUse thinks (game/g_utils.c Think_Delay): due deferred uses fire
  // through the same G_UseTargets entry (message + targets + depth guard).
  for (let i = st.delayed.length - 1; i >= 0; i--) {
    const d = st.delayed[i]!;
    if (st.time < d.at) continue;
    st.delayed.splice(i, 1);
    fireTargets(st, d.ent, d.depth);
  }
  const before = new Map<number, Vec3>();
  for (const m of st.movers) {
    if (m.ent.freed) continue;
    before.set(m.ent.num, v3(m.ent.origin[0], m.ent.origin[1], m.ent.origin[2]));
  }
  for (const tr of st.trains) {
    if (tr.ent.freed) continue;
    before.set(tr.ent.num, v3(tr.ent.origin[0], tr.ent.origin[1], tr.ent.origin[2]));
  }
  for (const sm of st.secretDoors) {
    if (sm.ent.freed) continue;
    before.set(sm.ent.num, v3(sm.ent.origin[0], sm.ent.origin[1], sm.ent.origin[2]));
  }
  for (const m of st.movers) {
    if (m.ent.freed) continue;
    const completed = moverThink(m, now);
    if (
      completed &&
      m.ent.classname === 'func_button' &&
      (m.state === MOVER_WAITING || m.state === MOVER_TOP)
    ) {
      // id button_wait fires the button's target on reaching the top.
      fireTargets(st, m.ent);
    }
    // id door_hit_top / door_hit_bottom: arrivals play sound_end; the DOWN
    // leg landing closes the door's areaportals (door_use_areaportals(false)).
    if (completed && m.ent.classname === 'func_door') {
      if (m.ent.sounds !== 1) {
        st.sounds.push({
          name: DOOR_SOUND_END,
          pos: v3(m.ent.origin[0], m.ent.origin[1], m.ent.origin[2]),
          born: now,
        });
      }
      if (m.state === MOVER_BOTTOM) setDoorPortals(st, m.ent, false);
    }
  }
  for (const tr of st.trains) {
    if (tr.ent.freed) continue;
    trainThink(tr, now, dt, (targetname) => {
      const pseudo: Edict = { ...tr.ent, target: targetname };
      fireTargets(st, pseudo);
    });
  }
  // Secret doors run their 5-move think chain (silent in C — the move funcs
  // carry no sound calls); rotating doors emit start/end sounds like sliders.
  for (const sm of st.secretDoors) {
    if (sm.ent.freed) continue;
    secretThink(sm, now, dt);
  }
  for (const rm of st.rotDoors) {
    if (rm.ent.freed) continue;
    const was = rm.state;
    const sounds = rotThink(rm, now, dt);
    for (const name of sounds) {
      st.sounds.push({
        name,
        pos: v3(rm.ent.origin[0], rm.ent.origin[1], rm.ent.origin[2]),
        born: now,
      });
    }
    // C door_hit_bottom (angular branch): the close leg landing shuts the
    // door's areaportals (the open leg opened them in SV_UseRotDoor).
    if (was === MOVER_GOING_DOWN && rm.state === MOVER_BOTTOM) {
      setDoorPortals(st, rm.ent, false);
    }
  }
  // Ambient map timers (g_func.c func_timer_think): due timers fire their
  // target through the same cascade, then reschedule on wait + crandom
  // spread from the state's dedicated timer stream (deterministic; never
  // the global Math.random, so gameplay consumption cannot shift ambience
  // phase). Runs without the game phase:
  // splash/speaker cadence needs no player, like C thinks.
  for (const t of st.timers) {
    if (t.ent.freed || t.nextAt < 0 || now < t.nextAt) continue;
    fireTargets(st, t.ent);
    t.nextAt = now + t.wait + (t.random > 0 ? (st.timerRand() * 2 - 1) * t.random : 0);
  }
  st.moverDeltas.clear();
  for (const m of st.movers) {
    if (m.ent.freed) continue;
    const b = before.get(m.ent.num);
    if (!b) continue;
    const dx = m.ent.origin[0]! - b[0]!;
    const dy = m.ent.origin[1]! - b[1]!;
    const dz = m.ent.origin[2]! - b[2]!;
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      st.moverDeltas.set(m.ent.num, v3(dx, dy, dz));
    }
  }
  // Trains displace riders the same way (SV_Push semantics).
  for (const tr of st.trains) {
    if (tr.ent.freed) continue;
    const b = before.get(tr.ent.num);
    if (!b) continue;
    const dx = tr.ent.origin[0]! - b[0]!;
    const dy = tr.ent.origin[1]! - b[1]!;
    const dz = tr.ent.origin[2]! - b[2]!;
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      st.moverDeltas.set(tr.ent.num, v3(dx, dy, dz));
    }
  }
  // Secret doors translate riders too (rotating doors only change angles,
  // so they record no origin delta — riders keep their world position).
  for (const sm of st.secretDoors) {
    if (sm.ent.freed) continue;
    const b = before.get(sm.ent.num);
    if (!b) continue;
    const dx = sm.ent.origin[0]! - b[0]!;
    const dy = sm.ent.origin[1]! - b[1]!;
    const dz = sm.ent.origin[2]! - b[2]!;
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      st.moverDeltas.set(sm.ent.num, v3(dx, dy, dz));
    }
  }
  // Pickup respawn (DoRespawn): re-materialize hidden items whose timer
  // (SetRespawn via SV_ConsumePickup) elapsed on level.time.
  for (const e of st.entities) {
    if (!e.freed && e.extra['respawnAt'] !== undefined) {
      DoRespawn(e, now);
    }
  }
  // Scripted corridor blasts (trigger_once/relay chains fire
  // target_explosion): every firing path pushes the relay targetname into
  // firedThisTick, so the tick resolves them here — immediate or delayed
  // via the fuse list (use_target_explosion think at level.time + delay).
  // Resolved once per targetname per tick: the loop pushes once per same-
  // named charge edict (base1's t151 is four), but C runs one G_UseTargets
  // pass per use — one resolution arms each charge exactly once.
  for (const t of new Set(st.firedThisTick)) fireExplosionTarget(st, t);
  // Phase 0 gameplay: monsters, bolts, fuses, debris/gibs, explosions.
  if (game) SV_GameTick(st, game, dt);
}

/**
 * Consume a pickup edict the way Touch_Item does after a successful grab:
 * hide it (SOLID_NOT) and arm the id respawn timer (SetRespawn, ~30s for
 * weapons/health/ammo, 20s for armor). SV_Tick re-materializes it via
 * DoRespawn. `delay` overrides the id table; `now` defaults to level.time.
 */
export function SV_ConsumePickup(st: ServerState, ent: Edict, delay?: number, now?: number): number {
  // id Touch_Item: a successful grab fires the item's target once
  // (G_UseTargets, ITEM_TARGETS_USED) — base1's shotgun fires t55, waking
  // the two TRIGGER_SPAWN soldiers. The NOT_* strip at spawn never touches
  // this bit, and nothing clears it, so re-takes after DoRespawn stay quiet.
  if (ent.target && !(ent.spawnflags & ITEM_TARGETS_USED)) {
    ent.spawnflags |= ITEM_TARGETS_USED;
    fireTargets(st, ent);
  }
  const t = now ?? st.time;
  const d = delay ?? respawnDelayFor(ent.classname);
  return SetRespawn(ent, d, t);
}

/** A headless body (pmove state) eligible for pusher carrying. */
export interface RiderBody {
  origin: Vec3;
  mins: Vec3;
  maxs: Vec3;
  /** edict num of the mover stood upon (pmove groundEntity; -1 = none) */
  groundEntity: number;
  onGround: boolean;
}

/**
 * SV_Push rider pass: carry bodies standing on movers that displaced this
 * tick (id g_phys.c: riders move with the pusher). Matches C semantics —
 * only groundEntity == pusher links ride; world-grounded and airborne
 * bodies are untouched. Must run after SV_Tick (reads moverDeltas) and
 * before the bodies' own movement for the tick.
 *
 * Ride-only-what-you-stand-on gate: the carry applies solely when the
 * rider's feet rest at the pusher's PRE-move top (1u tolerance for the
 * +1/32 contact rest). C links side-embedded bodies too (startsolid rule),
 * then leaves them behind or blocks on them; our ground link latches the
 * same way, so without the gate the exit-hall camper — leaning 5u inside
 * the *32 slab with its feet at the slab's base, not its top — would ride
 * the opening door south and strand outside the *33 volume (gate (t)).
 * Feet-on-top riders (lift/plug tops, the only physical carries) pass.
 * The top is read pre-move (current top minus this tick's dz): after the
 * platform rises the rider still sits at the old top, and testing against
 * the new top would strand every upward ride one tick behind.
 */
export function SV_CarryRiders(st: ServerState, bodies: RiderBody[]): void {
  for (const b of bodies) {
    if (!b.onGround || b.groundEntity < 0) continue;
    const d = st.moverDeltas.get(b.groundEntity);
    if (!d) continue;
    const top = pusherTopAt(st, b.groundEntity);
    if (top !== null) {
      const feet = b.origin[2]! + b.mins[2]!;
      if (Math.abs(feet - (top - d[2]!)) > 1) continue;
    }
    b.origin[0] = b.origin[0]! + d[0]!;
    b.origin[1] = b.origin[1]! + d[1]!;
    b.origin[2] = b.origin[2]! + d[2]!;
  }
}

/**
 * Current top face height of the pusher with this edict num (displaced
 * mover/train clip box), or null when it has no registered brush bounds
 * (secret doors displace riders without recorded bounds — carry those
 * unconditionally, as before).
 */
function pusherTopAt(st: ServerState, num: number): number | null {
  const m = st.movers.find((mm) => mm.ent.num === num);
  if (m) {
    const box = SV_MoverClipBox(st, m);
    return box ? box.maxs[2]! : null;
  }
  const tr = st.trains.find((tt) => tt.ent.num === num);
  if (tr) {
    const box = SV_TrainClipBox(st, tr);
    return box ? box.maxs[2]! : null;
  }
  return null;
}
// --- Phase 0: single authoritative sim (BRAIN.md §15) -------------------------
//
// The browser used to run a private driver sim (PlacedMonster[], barrels,
// bolts, monsterFire, stepBolts, driver door touch) and rendered only it, so
// server fixes never reached the screen. This section is the inversion:
// the server owns ALL gameplay state at 10Hz in SV_Tick — monsters (via the
// existing SV_MonsterTick path, resolved here with C cadence), barrels
// (misc_explobox + func_explosive), bolts (player + foe blaster edicts),
// explosions + muzzle/tracer/spark/sound events (visual feed for the
// driver), debris/gibs, scripted target_explosions and the player health
// pool. The driver (apps/web) renders from this state and forwards input
// via SV_PlayerFire, which owns damage. Pure data + the game tables; no
// rendering, no DOM.

/** Enemy hitscan tracer streak length (short muzzle streak, never eye-ending). */
export const SERVER_ENEMY_TRACER_LENGTH = 48;
/** id pellet spread basis: r/u are world units at this range (fire_lead). */
export const SV_PELLET_RANGE = 8192;
/** Static impact-puff lifetime in server seconds (driver spark sweep). */
export const SV_SPARK_TTL = 0.4;
/** id PARTICLE_GRAVITY (cl_fx.c ballistic spark falloff). */
export const SV_SPARK_GRAVITY = 40;
/** id sv_gravity default for tossed debris/gibs (g_phys.c SV_AddGravity). */
export const SV_TOSS_GRAVITY = 800;

/**
 * One light_use toggle event (game/g_misc.c:545): the style flipped, and the
 * resulting switch position ("m" on / "a" off, the CS_LIGHTS payload).
 */
export interface ServerLightToggle {
  style: number;
  value: string;
}

/**
 * One pending DelayedUse (game/g_utils.c:173 G_UseTargets delay branch):
 * the used entity (copied at schedule time) fires through fireTargets when
 * level.time reaches `at`. `depth` threads the cascade guard.
 */
export interface ServerDelayedUse {
  at: number;
  ent: Edict;
  depth: number;
}

/** C button_fire voice (game/g_func.c SP_func_button: sounds != 1). */
export const BUTTON_SOUND_START = 'switches/butn2.wav';
export { BUTTON_34_SHIFT } from './buttons.js';

/**
 * id water-contents bits for hitscan splash color (game/q_shared.h BSP
 * space, the space traceBox reports through SV_TraceFor): WATER 32 blue
 * (or brown when the hit surface is `*brwater`, g_weapon.c fire_lead),
 * SLIME 16, LAVA 8. Brown is a surface-name property with no channel in
 * TraceResult, so the pellet path resolves it through the optional
 * `SVFireOpts.brownWaterAt` surface query (route R9F-10b, server/game-owned
 * — no renderer-api or TraceResult change); WATER without the query stays
 * blue for legacy callers.
 */
export const BSP_WATER_BIT = 32;
export const BSP_SLIME_BIT = 16;
export const BSP_LAVA_BIT = 8;

/** Hitscan-vs-water splash color (g_weapon.c fire_lead water branch). */
export type WaterSplashKind = 'blue' | 'brown' | 'slime' | 'lava';

/** Flying blaster bolt (g_weapon.c fire_blaster / monster_fire_blaster). */
export interface ServerBolt {
  pos: Vec3;
  dir: Vec3; // normalized
  life: number;
  damage: number;
  /** Units/second (1000 player blaster, 600 soldier monster blaster). */
  speed: number;
  /** True for monster return fire (damages the player, never its owner). */
  foe: boolean;
  /** Server time the bolt was spawned (life expires on server time). */
  born: number;
}

/** Shootable explosive (g_misc.c barrel_delay / func_explosive_explode). */
export interface ServerBarrel {
  edict: Edict;
  /**
   * Damage origin: box bottom for misc_explobox (hull origin), bbox center
   * for func_explosive (a wall/slab middle). Matches the old driver layout
   * so radius math and the render base agree.
   */
  origin: Vec3;
  /** Hull size (explobox 32,32,40; brush bbox otherwise). */
  size: Vec3;
  /** Debris mass class (400 explobox, 75 func_explosive default). */
  mass: number;
  /** True for brush func_explosive (mass-formula debris), else explobox. */
  isFunc: boolean;
  /**
   * Lethal hit latched (takedamage NO + 0.2s fuse, barrel_delay). Further
   * hits are immune until the fuse blows.
   */
  fused: boolean;
}

/** Explosion visual kind (cl_tent.c TE_ paths). */
export type ServerExplosionKind = 'explosion1' | 'explosion2' | 'blaster';

/** Live explosion flash (TE_EXPLOSION1/2 big boom, TE_BLASTER touch). */
export interface ServerExplosion {
  pos: Vec3;
  born: number;
  kind: ServerExplosionKind;
  baseframe: number;
  yaw: number;
  /**
   * Impact normal for TE_BLASTER (cl_tent.c transmits dir: the ex_misc
   * model orients by it and CL_BlasterParticles sprays along it; NULL
   * plane in C sends the zero vector). Big booms send no dir.
   */
  dir?: Vec3;
}

/** One-shot muzzle-flash dlight request (id CL_MuzzleFlash). */
export interface ServerMuzzle {
  pos: Vec3;
  intensity: number;
  born: number;
  foe: boolean;
}

/** One queued hitscan tracer beam (origin + dir + color + length). */
export interface ServerTracer {
  origin: Vec3;
  dir: Vec3;
  color: number;
  length: number;
  born: number;
}

/** One queued particle-burst request (impact, trail, boom). */
export interface ServerSpark {
  pos: Vec3;
  color: number;
  /** Ballistic velocity (boom sparks) or null (static puffs). */
  vel: Vec3 | null;
  ttl: number;
  born: number;
  /**
   * Hitscan-vs-water splash color (g_weapon.c fire_lead water branch, C
   * TE_SPLASH 8-count color per contents: blue/brown/slime/lava). Absent on
   * dry puffs, blood and trails — the splash-vs-puff discriminator.
   */
  splash?: WaterSplashKind;
  /**
   * Flesh-hit blood marker (g_combat.c:490 T_Damage → SpawnDamage(TE_BLOOD)
   * for monster/client flesh; the fire_lead pellet path records it here).
   * Blaster flesh stays event-free (its takedamage branch runs T_Damage with
   * no TE of its own — pinned by the flesh-bolt server test).
   */
  blood?: boolean;
}

/** One queued positional-sound request (shots, impacts). */
export interface ServerSound {
  name: string;
  pos: Vec3;
  born: number;
  /**
   * Prestarted/toggled loop channel (game/g_target.c SP_target_speaker
   * spawnflags&1: ent->s.sound loops until toggled). Loops persist in this
   * queue (never drained, never 5s-pruned): start = entry added, stop =
   * entry removed, position = pos. The audio lane consumes loop-flagged
   * entries as loop channels (Mixer.startSound loop:true).
   */
  loop?: boolean;
}

/** Thrown chunk (g_misc.c ThrowDebris: MOVETYPE_BOUNCE, backoff 1.5). */
export interface ServerDebris {
  origin: Vec3;
  vel: Vec3;
  avel: Vec3;
  born: number;
  life: number;
  kind: 'debris1' | 'debris2' | 'debris3';
  rest: boolean;
}

/** Gib chunk (g_misc.c ThrowGib/ThrowHead: MOVETYPE_TOSS, backoff 1.0). */
export interface ServerGib {
  origin: Vec3;
  vel: Vec3;
  avel: Vec3;
  born: number;
  life: number;
  kind: 'meat' | 'chest' | 'bone' | 'head';
  rest: boolean;
}

/** Pending barrel fuse / target_explosion delay (server-time stepped). */
export interface ServerFuse {
  pos: Vec3;
  dmg: number;
  at: number;
  barrel?: { edict: Edict; origin: Vec3; size: Vec3; mass: number; dmg: number; isFunc: boolean };
}

/** Ambient map timer (func_timer, g_func.c SP_func_timer/func_timer_think). */
export interface ServerTimer {
  ent: Edict;
  /** Target fired on every cadence tick (G_UseTargets). */
  target: string;
  /** Base interval seconds (default 1.0). */
  wait: number;
  /** Random spread seconds (clamped to wait - 0.1, may be 0). */
  random: number;
  /** One-shot arming delay for use-started timers. */
  delay: number;
  /**
   * Next server-time firing, or -1 when toggled off (func_timer_use).
   * C runs thinks on exact level.time; the 10Hz tick fires up to one
   * quantum late.
   */
  nextAt: number;
}

/** Live player body for the gameplay phase (touch, LOS, bolt flesh). */
export interface SVPlayerBody {
  pos: Vec3;
  mins: Vec3;
  maxs: Vec3;
  /** Eye height above the origin (22 standing, 12 ducked, pmove.c). */
  view: number;
}

/** Gameplay-phase inputs for SV_Tick (absent = movers/trains/respawn only). */
export interface SVGameTick {
  player: SVPlayerBody;
  /** World trace (C-mask via SV_TraceFor; wrap in SV_ClipTrace for clips). */
  trace: TraceFn;
  /** Sight trace for visible() (C MASK_OPAQUE, ignores WINDOW/glass). */
  sightTrace?: TraceFn;
  /** Monster nav graph; null builds the trivial two-node chase graph. */
  nav?: MonsterNav | null;
  /** Caller-seeded RNG (deterministic tests); defaults to Math.random. */
  rand?: () => number;
  /**
   * Solid-aware point contents for the P_WorldEffects sampler. Defaults to
   * the hooks installed by SV_SetPmoveWorldFromBsp; tests pass a synthetic
   * pool directly (no map needed).
   */
  contents?: PointContentsFn;
}

const ZERO_HULL: Vec3 = v3(0, 0, 0);

/** Slab segment-vs-AABB (hitscan flesh tests: monsters, barrels, player). */
function segmentAabbSeg(
  origin: Vec3,
  delta: Vec3,
  mins: Vec3,
  maxs: Vec3,
): number | null {
  let tEnter = 0;
  let tExit = 1;
  for (let k = 0; k < 3; k++) {
    const o = origin[k]!;
    const d = delta[k]!;
    if (d === 0) {
      if (o < mins[k]! || o > maxs[k]!) return null;
      continue;
    }
    let t0 = (mins[k]! - o) / d;
    let t1 = (maxs[k]! - o) / d;
    if (t0 > t1) {
      const t = t0;
      t0 = t1;
      t1 = t;
    }
    if (t0 > tEnter) tEnter = t0;
    if (t1 < tExit) tExit = t1;
    if (tEnter > tExit) return null;
  }
  if (tEnter > 1 || tExit < 0) return null;
  return tEnter;
}

/**
 * Spawn a synthetic monster (test hook + devroom synthetics): creates and
 * links the edict, maps the classname onto the lite defs (soldier/gunner/
 * infantry; unmapped kinds stay present but dormant, like the lump path),
 * faces yaw. Seen latches immediately so synthetic bodies act without an
 * acquire walk.
 */
export function SV_SpawnMonster(
  st: ServerState,
  classname: string,
  origin: Vec3,
  yaw = 0,
): ServerMonster {
  const e = spawnEdict({ classname, origin: `${origin[0]} ${origin[1]} ${origin[2]}` });
  SV_LinkEdict(st, e);
  const kind = monsterKindOf(classname);
  // id skin assignment parity with the lump path (m_soldier.c SP_ funcs):
  // light troops wear skin 0 (blaster), normals skin 2 (shotgun),
  // supershots skin 4 (machinegun). selectSoldierAttack keys the weapon off
  // the same skins, so synthetics must carry them too. Spawn HP follows the
  // same skins (20/30/40 — the shared lite def defaults to the normal class).
  if (classname === 'monster_soldier_light') e.extra['skinnum'] = '0';
  else if (classname === 'monster_soldier') e.extra['skinnum'] = '2';
  else if (classname === 'monster_soldier_ss') e.extra['skinnum'] = '4';
  // Live synthetic bodies block movement like lump spawns (SOLID_BBOX).
  e.solid = SOLID_BBOX;
  e.movetype = MOVETYPE_STEP;
  const m: ServerMonster = {
    edict: e,
    state: kind ? spawnMonster(kind) : spawnMonster('soldier'),
    kind,
    ambush: false,
    triggered: false,
    woken: true,
    seen: true,
    reactionAt: 0,
    duckUntil: 0,
    duckShoot: false,
    burstUntil: 0,
    burstHeld: false,
    combatGoal: null,
    combatHold: false,
    combatDone: false,
    slideDir: 0,
    patrolCorner: '',
    patrolGoal: null,
    patrolWaitUntil: 0,
  };
  if (kind === 'soldier') {
    const skin = Number.parseInt((e.extra['skinnum'] as string) ?? '2', 10);
    m.state.health = soldierHealthForSkin(Number.isFinite(skin) ? skin : 2);
  }
  m.state.yaw = ((yaw % 360) + 360) % 360;
  st.monsters.push(m);
  return m;
}

/**
 * Add a synthetic shootable barrel (test hook): links an explobox edict and
 * records it. Defaults are the id SP_misc_explobox table values.
 */
export function SV_AddBarrel(
  st: ServerState,
  origin: Vec3,
  opts?: { health?: number; dmg?: number; mass?: number; size?: Vec3; isFunc?: boolean },
): ServerBarrel {
  const e = spawnEdict({ classname: 'misc_explobox', origin: `${origin[0]} ${origin[1]} ${origin[2]}` });
  e.health = opts?.health ?? 10;
  e.maxHealth = e.health;
  e.dmg = opts?.dmg ?? 150;
  SV_LinkEdict(st, e);
  const b: ServerBarrel = {
    edict: e,
    origin: v3(origin[0], origin[1], origin[2]),
    size: opts?.size ?? v3(32, 32, 40),
    mass: opts?.mass ?? 400,
    isFunc: opts?.isFunc ?? false,
    fused: false,
  };
  st.barrels.push(b);
  return b;
}

/**
 * T_Damage on the player pool (g_combat.c easy-half scaling owned here).
 * Records the applied total + latest attacker origin for the driver's
 * P_DamageFeedback port (drain via SV_DrainPlayerDamage). `from` is the
 * C `damage_from` point (attacker origin); omit it for world damage.
 */
export function SV_DamagePlayer(st: ServerState, dmg: number, from?: Vec3 | null): number {
  if (st.playerHealth <= 0) return 0;
  const applied = Math.max(1, Math.round(dmg * skillMultiplier(st.skill)));
  st.playerHealth = Math.max(0, st.playerHealth - applied);
  st.lastPlayerDamage += applied;
  if (from) st.lastPlayerDamageFrom = v3(from[0], from[1], from[2]);
  return applied;
}

/**
 * Drain the recorded player-damage totals (one-shot pump, like the muzzle
 * / tracer drains): returns the applied sum + latest attacker origin since
 * the last drain, or null when nothing landed. Clears both fields.
 */
export function SV_DrainPlayerDamage(st: ServerState): { amount: number; from: Vec3 | null } | null {
  if (!(st.lastPlayerDamage > 0)) return null;
  const out = { amount: st.lastPlayerDamage, from: st.lastPlayerDamageFrom };
  st.lastPlayerDamage = 0;
  st.lastPlayerDamageFrom = null;
  return out;
}

/** Heal (pickup path writes back through here; clamped to the max pool). */
export function SV_HealPlayer(st: ServerState, amount: number): number {
  st.playerHealth = Math.min(st.playerMaxHealth, Math.max(0, st.playerHealth + amount));
  return st.playerHealth;
}

/** Set the pool directly (respawn path; clamped to 0..max). */
export function SV_SetPlayerHealth(st: ServerState, hp: number): number {
  st.playerHealth = Math.min(st.playerMaxHealth, Math.max(0, hp));
  return st.playerHealth;
}

/**
 * Set the timed-suit timers (pickup/respawn path; level.time seconds, the
 * C breather/enviro_framenum domain). The driver mirrors its PlayerState
 * timers here after a suit grant (like SV_SetPlayerHealth for pickups) and
 * clears them on respawn (C p_client.c zeroes both framenums on respawn).
 */
export function SV_SetPlayerSuit(st: ServerState, breatherUntil: number, enviroUntil: number): void {
  st.playerBreatherUntil = Math.max(0, breatherUntil);
  st.playerEnviroUntil = Math.max(0, enviroUntil);
}

/**
 * T_Damage on a monster (g_combat.c gib-first ordering via monsterPain).
 * Gibbing spawns meat/chest/head extras + the udeath sound and marks
 * DEAD_DEAD (unhittable from then on). Returns the pain result.
 * `pointZ` is the impact height relative to the monster origin for the
 * soldier head-shot death branch (omitted for radius/melee kills).
 */
export function SV_DamageMonster(
  st: ServerState,
  m: ServerMonster,
  damage: number,
  rand: () => number,
  pointZ?: number,
): 'gib' | 'dead' | 'pain' | 'none' {
  const wasAlive = !m.state.dead && !m.state.gibbed;
  const res = monsterPain(m.state, damage, rand, pointZ);
  if (wasAlive && !m.seen) {
    // C M_ReactToDamage: a client hurting a monster acquires it (FoundTarget
    // on the enemy change — no visibility requirement). Only on the unseen→
    // seen edge (re-hits never re-arm the hold, like C's early return when
    // the attacker is already the enemy).
    m.seen = true;
    m.reactionAt = -1;
  }
  if ((res === 'dead' || res === 'gib') && wasAlive) {
    // C Killed(): every fresh SVF_MONSTER death counts (this sim has no
    // AI_GOOD_GUY bodies; deadsoldier minces run a separate counter).
    st.killedMonsters++;
    // The hull drops only when the death move completes (C soldier_dead /
    // infantry_dead endfunc sets SVF_DEADMONSTER): the tick flips solid to
    // SOLID_NOT as deadDone latches. Dying bodies keep blocking until then.
    // Gibbed bodies are gone (SOLID_NOT now — SV_MonsterClipBox gates gibbed
    // either way). Corpses stay hittable via the state-based sweeps.
    if (res === 'gib' && wasAlive) m.edict.solid = SOLID_NOT;
  }
  if ((res === 'dead' || res === 'gib') && wasAlive && m.edict.target) {
    // id monster_death_use: a dying monster fires its target (with the
    // enemy as activator) — the t39 -> t40 relay in base1 wakes/alerts the
    // next ambush. Fires once, on the fresh transition (corpse re-hits
    // return 'dead' again but must not re-fire); item drops (self->item)
    // are skipped — no base1 monster carries one.
    fireTargets(st, m.edict);
  }
  if (res === 'gib') {
    st.sounds.push({ name: GIB_SOUND, pos: v3(m.edict.origin[0], m.edict.origin[1], m.edict.origin[2]), born: st.time });
    const kinds: ServerGib['kind'][] = ['meat', 'meat', 'meat', 'chest', 'head'];
    for (const kind of kinds) {
      const scale = damage < 50 ? 0.7 : 1.2;
      const vx = Math.max(-300, Math.min(300, 100 * (rand() * 2 - 1) * scale * 0.5));
      const vy = Math.max(-300, Math.min(300, 100 * (rand() * 2 - 1) * scale * 0.5));
      const vz = Math.max(200, Math.min(500, (200 + 100 * rand()) * scale * 0.5));
      st.gibs.push({
        origin: v3(
          m.edict.origin[0]! + (rand() * 2 - 1) * 16,
          m.edict.origin[1]! + (rand() * 2 - 1) * 16,
          m.edict.origin[2]! + (rand() * 2 - 1) * 16,
        ),
        vel: v3(vx, vy, vz),
        avel: v3(rand() * 600, rand() * 600, rand() * 600),
        born: st.time,
        life: 10 + rand() * 10,
        kind,
        rest: false,
      });
    }
  }
  return res;
}

/**
 * T_Damage on a misc_deadsoldier corpse (C g_misc.c misc_deadsoldier_die):
 * hits accumulate on the edict health (0 at spawn); at/below -80 the hit
 * minces — 4x sm_meat + head2 gibs through the shared gib pipeline plus
 * the udeath sound. The corpse is NOT freed (C has no G_FreeEdict here),
 * so it keeps taking damage and re-gibs on every qualifying hit.
 * Returns true exactly when this hit minced (caller synthesizes the
 * driver 'gib' event from the per-edict gib counter in extra).
 */
export function SV_DamageDeadsoldier(
  st: ServerState,
  e: Edict,
  damage: number,
  rand: () => number,
): boolean {
  const hit = damageDeadsoldier(e.health, damage);
  e.health = hit.health;
  if (!hit.gibbed) return false;
  st.sounds.push({ name: DEADSOLDIER_GIB_SOUND, pos: v3(e.origin[0], e.origin[1], e.origin[2]), born: st.time });
  for (const kind of DEADSOLDIER_GIB_MODELS) {
    const gkind: ServerGib['kind'] = kind === 'head2' ? 'head' : 'meat';
    const scale = damage < 50 ? 0.7 : 1.2;
    st.gibs.push({
      origin: v3(
        e.origin[0]! + (rand() * 2 - 1) * 16,
        e.origin[1]! + (rand() * 2 - 1) * 16,
        e.origin[2]! + (rand() * 2 - 1) * 16,
      ),
      vel: v3(
        Math.max(-300, Math.min(300, 100 * (rand() * 2 - 1) * scale * 0.5)),
        Math.max(-300, Math.min(300, 100 * (rand() * 2 - 1) * scale * 0.5)),
        Math.max(200, Math.min(500, (200 + 100 * rand()) * scale * 0.5)),
      ),
      avel: v3(rand() * 600, rand() * 600, rand() * 600),
      born: st.time,
      life: 10 + rand() * 10,
      kind: gkind,
      rest: false,
    });
  }
  const seen = Number.parseInt(e.extra['gibHits'] ?? '0', 10);
  e.extra['gibHits'] = String((Number.isFinite(seen) ? seen : 0) + 1);
  return true;
}

/**
 * Live func_explosive barrel owning a brush-clip edict num (SV_ClipTrace
 * entityNum). Null for world hits (0), func_walls (no barrel record) and
 * dead/fused brushes. Shared by the bolt and hitscan touch paths so both
 * resolve a SOLID_BSP touch against the brush edict itself, like C.
 */
export function barrelOfClip(st: ServerState, entityNum: number): ServerBarrel | null {
  if (entityNum < 0) return null;
  const b = st.barrels.find((bb) => bb.isFunc && !bb.edict.freed && bb.edict.num === entityNum);
  return b ?? null;
}

/**
 * Live func_button owning a brush-clip edict num (SV_ClipTrace entityNum).
 * Null for world hits (0) and freed brushes; health gating happens in
 * SV_DamageButton (C installs takedamage only when health is set, so
 * touch/use-only buttons fall through to the impact flash). Shared by the
 * bolt touch path so a shot button resolves against the brush edict itself,
 * like C.
 */
export function buttonOfClip(st: ServerState, entityNum: number): Mover | null {
  if (entityNum <= 0) return null;
  const m = st.movers.find(
    (mm) => mm.ent.classname === 'func_button' && !mm.ent.freed && mm.ent.num === entityNum,
  );
  return m ?? null;
}

/**
 * T_Damage on a shootable button (g_func.c button_killed): health-set
 * buttons answer bolts (C blaster_touch takedamage branch — damage only, no
 * TE_BLASTER flash); the lethal hit restores health and fires (button_fire —
 * a no-op while the button is already UP/TOP, so a wait -1 hold like base1's
 * *13 can never re-fire). Non-lethal hits accumulate across shots (C
 * T_Damage runs no pain gate on brushes). Health-less buttons never take
 * damage here (C installs no takedamage for them — bolts spark off).
 *
 * Base1 scope note: the only health-gated button (*13, wait -1) holds TOP
 * forever after its one lethal hit, so C's takedamage=NO clear is
 * unobservable here — repeat shots re-run the kill into the UP/TOP no-op.
 * A wait>=0 health button (none in base1) would re-fire on a post-return
 * shot where C stays silent; revisit with a takedamage field if one ships.
 */
export function SV_DamageButton(st: ServerState, m: Mover, dmg: number): boolean {
  if (m.ent.freed || !(m.ent.health > 0)) return false;
  m.ent.health -= dmg;
  if (m.ent.health > 0) return true;
  m.ent.health = m.ent.maxHealth;
  SV_UseMover(st, m);
  return true;
}

/**
 * T_Damage on a barrel (g_misc.c barrel_delay): the first lethal hit latches
 * the fuse (takedamage NO + think = barrel_explode at level.time + 2 frames)
 * and arms the 0.2s fuse; the fuse then runs T_RadiusDamage + BecomeExplosion.
 * Chained hits (damageRadius chains) re-enter through the same fuse; hits
 * during the fuse are immune via the fused latch.
 *
 * C ordering (barrel_delay / func_explosive_explode): the edict stays live
 * AND solid for the 0.2s — mesh rendered, clip blocking — then frees and
 * opens atomically at explode time. Freeing at damage time instead leaves a
 * 2-tick invisible wall (mesh hidden, clip still stopping bodies); the free
 * therefore happens at fuse blow, next to SV_RemoveBrushClip.
 */
export function SV_DamageBarrel(
  st: ServerState,
  b: ServerBarrel,
  dmg: number,
): boolean {
  if (b.edict.freed || b.fused) return false;
  b.edict.health -= dmg;
  if (b.edict.health > 0) return false;
  b.fused = true;
  st.fuses.push({
    pos: v3(b.origin[0], b.origin[1], b.origin[2]),
    dmg: b.edict.dmg,
    at: barrelFuseAt(st.time),
    barrel: {
      edict: b.edict,
      origin: v3(b.origin[0], b.origin[1], b.origin[2]),
      size: v3(b.size[0], b.size[1], b.size[2]),
      mass: b.mass,
      dmg: b.edict.dmg,
      isFunc: b.isFunc,
    },
  });
  return true;
}

/**
 * Explosion visual + sound + radius damage (TE_EXPLOSION1/2 barrel/func/
 * target, TE_BLASTER touch flash). Big booms emit the 256-count ballistic
 * burst (CL_ExplosionParticles) plus the client's TE sound — rocklx1a for
 * TE_EXPLOSION1, grenlx1a for TE_EXPLOSION2 (cl_tent.c registrations; the
 * old explod1.wav name appears nowhere in C). The blaster flash keeps its
 * 40-spark burst (added by SV_BlasterImpact, not here) and its lashit from
 * the touch path. Grounded booms render as explosion2 (BecomeExplosion2),
 * airborne as explosion1 (BecomeExplosion1). No scorch (Q2 has none).
 */
export function SV_SpawnExplosion(
  st: ServerState,
  pos: Vec3,
  dmg: number,
  opts?: { kind?: ServerExplosionKind; trace?: TraceFn; rand?: () => number; dir?: Vec3 },
): void {
  const rand = opts?.rand ?? Math.random;
  let kind = opts?.kind ?? 'explosion1';
  let baseframe = 0;
  if (opts?.kind === 'blaster') {
    baseframe = 0;
  } else if (opts?.kind === 'explosion2') {
    kind = 'explosion2';
    baseframe = 30;
  } else if (opts?.trace) {
    const grounded =
      opts.trace(v3(pos[0], pos[1], pos[2]! + 1), ZERO_HULL, ZERO_HULL, v3(pos[0], pos[1], pos[2]! - 8)).fraction < 1;
    if (grounded) {
      kind = 'explosion2';
      baseframe = 30;
    } else {
      baseframe = explosionBaseframe('explosion1', rand);
    }
  } else {
    baseframe = explosionBaseframe('explosion1', rand);
  }
  st.explosions.push({
    pos: v3(pos[0], pos[1], pos[2]),
    born: st.time,
    kind,
    baseframe,
    yaw: (rand() * 360) | 0,
    ...(opts?.dir ? { dir: v3(opts.dir[0], opts.dir[1], opts.dir[2]) } : {}),
  });
  if (kind === 'blaster') return;
  for (let i = 0; i < 256; i++) {
    st.sparks.push({
      pos: v3(pos[0]! + ((rand() * 32 - 16) | 0), pos[1]! + ((rand() * 32 - 16) | 0), pos[2]! + ((rand() * 32 - 16) | 0)),
      color: 0xe0 + ((rand() * 8) | 0),
      vel: v3((rand() * 384 - 192) | 0, (rand() * 384 - 192) | 0, (rand() * 384 - 192) | 0),
      ttl: 0.625 + rand() * 0.375,
      born: st.time,
    });
  }
  st.sounds.push({ name: kind === 'explosion2' ? 'weapons/grenlx1a.wav' : 'weapons/rocklx1a.wav', pos: v3(pos[0], pos[1], pos[2]), born: st.time });
  void dmg;
}

/**
 * id T_RadiusDamage (g_combat.c): distance is measured from the entity's
 * bbox CENTER (mins+maxs)/2, points = dmg - 0.5*len, the attacker takes
 * half, and CanDamage (LOS) must pass or the entity is skipped. Barrels
 * chain through the 0.2s fuse (SV_DamageBarrel). Corpses keep their skip
 * (radius never minces — only direct fire does). C deals damage only when
 * points > 0 (a dmg-0 blast chips nothing); the caller-side min-1 applies
 * to positive falloff only.
 *
 * C CanDamage (g_combat.c) special-cases MOVETYPE_PUSH: bmodels measure to
 * the bbox midpoint and the trace ending INSIDE the brush itself
 * (trace.ent == targ) counts as damageable. Without that self-hit rule a
 * func_explosive's own clip blocks its LOS and splash can never kill it —
 * base1's opener (barrels blowing the *20 wall) stops working.
 */
export function SV_RadiusDamage(
  st: ServerState,
  pos: Vec3,
  dmg: number,
  player: SVPlayerBody,
  trace: TraceFn,
  rand: () => number,
): void {
  const radius = radiusDamageRadius(dmg);
  if (!(radius > 0)) return;
  const canDamage = (target: Vec3): boolean => trace(pos, ZERO_HULL, ZERO_HULL, target).fraction >= 1;
  for (const m of st.monsters) {
    if (m.state.dead || m.state.gibbed || (m.triggered && !m.woken)) continue;
    const cx = m.edict.origin[0]! + (MONSTER_HULL_MINS[0]! + MONSTER_HULL_MAXS[0]!) / 2;
    const cy = m.edict.origin[1]! + (MONSTER_HULL_MINS[1]! + MONSTER_HULL_MAXS[1]!) / 2;
    const cz = m.edict.origin[2]! + (MONSTER_HULL_MINS[2]! + MONSTER_HULL_MAXS[2]!) / 2;
    const center = v3(cx, cy, cz);
    const len = Math.hypot(center[0]! - pos[0]!, center[1]! - pos[1]!, center[2]! - pos[2]!);
    if (len >= radius) continue;
    if (!canDamage(center)) continue;
    const pts = radiusDamagePoints(dmg, len);
    if (!(pts > 0)) continue;
    SV_DamageMonster(st, m, Math.max(1, Math.round(pts)), rand);
  }
  const pcenter = v3(player.pos[0], player.pos[1], player.pos[2]! + 4);
  const pd = Math.hypot(pcenter[0]! - pos[0]!, pcenter[1]! - pos[1]!, pcenter[2]! - pos[2]!);
  if (pd < radius && canDamage(pcenter)) {
    // The attacker (us, who shot the barrel) takes half damage.
    const atk = radiusDamageAttackerPoints(radiusDamagePoints(dmg, pd));
    if (atk > 0) SV_DamagePlayer(st, Math.max(1, Math.round(atk)), pos);
  }
  for (const b of st.barrels) {
    if (b.edict.freed) continue;
    const bx = b.isFunc ? b.origin[0]! : b.origin[0]! + b.size[0]! / 2;
    const by = b.isFunc ? b.origin[1]! : b.origin[1]! + b.size[1]! / 2;
    const bz = b.isFunc ? b.origin[2]! : b.origin[2]! + b.size[2]! / 2;
    const bcenter = v3(bx, by, bz);
    const bd = Math.hypot(bcenter[0]! - pos[0]!, bcenter[1]! - pos[1]!, bcenter[2]! - pos[2]!);
    if (bd >= radius) continue;
    if (b.isFunc) {
      const los = trace(pos, ZERO_HULL, ZERO_HULL, bcenter);
      if (!(los.fraction >= 1 || los.entityNum === b.edict.num)) continue;
    } else if (!canDamage(bcenter)) continue;
    const pts = radiusDamagePoints(dmg, bd);
    if (!(pts > 0)) continue;
    SV_DamageBarrel(st, b, Math.max(1, Math.round(pts)));
  }
}

/**
 * TE_BLASTER wall impact (g_weapon.c blaster_touch, non-takedamage branch):
 * 40 dir-biased sparks (cl_fx.c CL_BlasterParticles: origin jitter
 * ((rand&7)-4) plus d*dir with d = rand&15, velocity dir*30 + crand*40,
 * gravity falloff, life 0.5+frand*0.3), the 4-frame ex_misc flash carrying
 * the impact normal (cl_tent.c orients by it), and lashit. Flesh hits
 * (takedamage) run T_Damage with NO temp entity in C — callers resolve
 * those as damage only and never come here.
 */
export function SV_BlasterImpact(
  st: ServerState,
  pos: Vec3,
  damage: number,
  hitMonster: ServerMonster | null,
  rand: () => number,
  dir?: Vec3,
): void {
  const d = dir ?? v3(0, 0, 0);
  for (let i = 0; i < 40; i++) {
    const spread = (rand() * 16) | 0;
    st.sparks.push({
      pos: v3(
        pos[0]! + (((rand() * 8) | 0) - 4) + spread * d[0]!,
        pos[1]! + (((rand() * 8) | 0) - 4) + spread * d[1]!,
        pos[2]! + (((rand() * 8) | 0) - 4) + spread * d[2]!,
      ),
      color: 0xe0 + ((rand() * 8) | 0),
      vel: v3(
        d[0]! * 30 + (rand() * 2 - 1) * 40,
        d[1]! * 30 + (rand() * 2 - 1) * 40,
        d[2]! * 30 + (rand() * 2 - 1) * 40,
      ),
      ttl: 0.5 + rand() * 0.3,
      born: st.time,
    });
  }
  SV_SpawnExplosion(st, pos, 0, { kind: 'blaster', rand, dir: d });
  st.sounds.push({ name: 'weapons/lashit.wav', pos: v3(pos[0], pos[1], pos[2]), born: st.time });
  if (hitMonster) SV_DamageMonster(st, hitMonster, damage, rand, pos[2]! - hitMonster.edict.origin[2]!);
}

/** Fire one target_explosion: immediate, or delayed via the fuse list. */
export function fireExplosionTarget(st: ServerState, targetname: string): void {
  // C G_UseTargets fires every same-named charge (base1's t151 is four):
  // each keeps its own origin/delay.
  for (const ex of st.explosionTargets.get(targetname) ?? []) {
    if (ex.delay > 0) {
      st.fuses.push({ pos: v3(ex.origin[0], ex.origin[1], ex.origin[2]), dmg: ex.dmg, at: targetExplosionFuseAt(st.time, ex.delay) });
      continue;
    }
    SV_SpawnExplosion(st, ex.origin, 0);
  }
}

/**
 * id splash_color table (cl_tent.c): TE_SPLASH color by `sounds` key —
 * 0 unknown, 1 sparks, 2 blue water, 3 brown water, 4 slime, 5 lava,
 * 6 blood. sounds > 6 renders color 0x00. Only sounds 1 plays a sound
 * (spark5/6/7 pick).
 */
export const SPLASH_COLORS: readonly number[] = [0x00, 0xe0, 0xb0, 0x50, 0xd0, 0xe0, 0xe8];

/**
 * Fire one target_splash (g_target.c use_target_splash): TE_SPLASH burst —
 * `count` particles (cl_fx.c CL_ParticleEffect: origin jitter ((rand&7)-4)
 * plus d*dir with d = rand&31, velocity crand*20, gravity falloff, life
 * 0.5+frand*0.3, color base + (rand&7)) plus the sounds-1 spark sound (C
 * picks spark5/6/7 by rand&3: 0 -> 5, 1 -> 6, else 7).
 */
export function fireSplashTarget(
  st: ServerState,
  targetname: string,
  rand: () => number = Math.random,
): void {
  for (const sp of st.splashes.get(targetname) ?? []) {
    const base = sp.sounds >= 0 && sp.sounds < SPLASH_COLORS.length ? SPLASH_COLORS[sp.sounds]! : 0x00;
    for (let i = 0; i < sp.count; i++) {
      const d = (rand() * 32) | 0;
      st.sparks.push({
        pos: v3(
          sp.origin[0]! + (((rand() * 8) | 0) - 4) + d * sp.dir[0]!,
          sp.origin[1]! + (((rand() * 8) | 0) - 4) + d * sp.dir[1]!,
          sp.origin[2]! + (((rand() * 8) | 0) - 4) + d * sp.dir[2]!,
        ),
        color: base + ((rand() * 8) | 0),
        vel: v3((rand() * 2 - 1) * 20, (rand() * 2 - 1) * 20, (rand() * 2 - 1) * 20),
        ttl: 0.5 + rand() * 0.3,
        born: st.time,
      });
    }
    if (sp.sounds === 1) {
      const r = (rand() * 4) | 0;
      st.sounds.push({
        name: r === 0 ? 'world/spark5.wav' : r === 1 ? 'world/spark6.wav' : 'world/spark7.wav',
        pos: v3(sp.origin[0], sp.origin[1], sp.origin[2]),
        born: st.time,
      });
    }
  }
}

/**
 * Use a func_timer the id way (g_func.c func_timer_use): a running timer
 * stops; a stopped one fires immediately (or arms `delay`) and resumes the
 * wait cadence. `depth` threads the fireTargets cascade guard.
 */
export function useTimer(st: ServerState, t: ServerTimer, depth = 0): void {
  if (t.nextAt >= 0) {
    t.nextAt = -1;
    return;
  }
  if (t.delay > 0) {
    t.nextAt = st.time + t.delay;
    return;
  }
  fireTargets(st, t.ent, depth);
  t.nextAt = st.time + t.wait + (t.random > 0 ? (st.timerRand() * 2 - 1) * t.random : 0);
}

/**
 * Debris for one exploded barrel (g_misc.c barrel_explode: 2 big (debris1)
 * + 4 bottom corners (debris3) + 8 small (debris2)). func_explosive instead
 * uses its mass class (mass/100 cap 8 big + mass/25 cap 16 small).
 */
function spawnBarrelDebris(
  st: ServerState,
  b: { origin: Vec3; size: Vec3; mass: number; dmg: number; isFunc: boolean },
  rand: () => number,
): void {
  const pushDebris = (kind: ServerDebris['kind'], origin: Vec3, speed: number): void => {
    st.debris.push({
      origin: v3(origin[0], origin[1], origin[2]),
      vel: v3(
        100 * (rand() * 2 - 1) * speed,
        100 * (rand() * 2 - 1) * speed,
        (100 + 100 * rand()) * speed,
      ),
      avel: v3(rand() * 600, rand() * 600, rand() * 600),
      born: st.time,
      life: 5 + rand() * 5,
      kind,
      rest: false,
    });
  };
  const jitter = (center: Vec3, size: Vec3): Vec3 =>
    v3(
      center[0]! + (rand() * 2 - 1) * size[0]!,
      center[1]! + (rand() * 2 - 1) * size[1]!,
      center[2]! + (rand() * 2 - 1) * size[2]!,
    );
  const center = v3(b.origin[0]! + b.size[0]! / 2, b.origin[1]! + b.size[1]! / 2, b.origin[2]! + b.size[2]! / 2);
  if (b.isFunc) {
    const { big, small } = funcExplosiveDebris(b.mass);
    for (let i = 0; i < big; i++) pushDebris('debris1', jitter(center, b.size), 1);
    for (let i = 0; i < small; i++) pushDebris('debris2', jitter(center, b.size), 2);
    return;
  }
  const spd = barrelDebrisSpeeds(b.dmg);
  for (let i = 0; i < 2; i++) pushDebris('debris1', jitter(center, b.size), spd.big);
  for (let cx = 0; cx < 2; cx++) {
    for (let cy = 0; cy < 2; cy++) {
      pushDebris('debris3', v3(b.origin[0]! + cx * b.size[0]!, b.origin[1]! + cy * b.size[1]!, b.origin[2]!), spd.corner);
    }
  }
  for (let i = 0; i < 8; i++) pushDebris('debris2', jitter(center, b.size), spd.small);
}

/**
 * Resolve one monster 'fire' frame (m_soldier.c soldier_fire / m_gunner.c
 * GunnerFire+GunnerGrenade / m_infantry.c InfantryMachineGun+infantry_smack):
 * the soldier weapon is skin-determined (never random); blaster skins spawn
 * a real foe bolt, shotgun/machinegun skins draw short yellow muzzle
 * streaks and roll id's pHit, grenades leave the tube only on the C
 * frames, infantry melee (attack2) resolves the true smack flashlessly
 * (C fire_hit emits no muzzle/dlight/tracer) while soldier/gunner
 * point-blank events resolve as gunfire (their C melee is NULL). Every
 * ballistic shot carries its enemy muzzle dlight.
 *
 * Tracer verdict vs the original: C fire_lead draws NO beam — bullets are
 * instant traces with a TE_GUNSHOT impact puff only. The short muzzle
 * streaks here are a deliberate readability aid (never muzzle→eye beams);
 * muzzle offsets, dlight, sounds and impact sparks follow the C tables.
 */
function resolveMonsterFire(
  st: ServerState,
  m: ServerMonster,
  ev: MonsterEvent,
  player: SVPlayerBody,
  rand: () => number,
): void {
  if (st.playerHealth <= 0) return;
  const eye = v3(player.pos[0], player.pos[1], player.pos[2]! + player.view);
  const dx = eye[0]! - m.edict.origin[0]!;
  const dy = eye[1]! - m.edict.origin[1]!;
  const dz = eye[2]! - m.edict.origin[2]!;
  const dist = Math.hypot(dx, dy, dz);
  if (dist > 1000) return;
  const fwd = v3();
  const right = v3();
  const up = v3();
  AngleVectors(v3(0, m.state.yaw, 0), fwd, right, up);
  const move = ev.move;
  const skinWeapon = m.kind === 'soldier' ? soldierWeaponForSkin(skinOf(m)) : null;
  let flashId = MZ2_SOLDIER_SHOTGUN_1;
  if (m.kind === 'soldier') {
    if (skinWeapon === 'blaster') flashId = MZ2_SOLDIER_BLASTER_1;
    // C soldier_fire4 fires with flash_number 3 (machinegun_flash[3] =
    // MZ2_SOLDIER_MACHINEGUN_4); duck/death mg one-shots keep the legacy
    // parity slot.
    else if (skinWeapon === 'machinegun')
      flashId = move === 'attack4' ? MZ2_SOLDIER_MACHINEGUN_4 : MZ2_SOLDIER_MACHINEGUN_1 + (ev.frame % 2);
    else flashId = MZ2_SOLDIER_SHOTGUN_1;
  } else if (move === 'attack_grenade') flashId = MZ2_GUNNER_GRENADE_1 + (ev.frame % 4);
  else if (m.kind === 'gunner') flashId = MZ2_GUNNER_MACHINEGUN_1 + (ev.frame % 8);
  else if (m.kind === 'infantry') {
    // m_infantry.c InfantryMachineGun: the attack1 fire frame (attak111)
    // always uses flash MZ2_INFANTRY_MACHINEGUN_1 and aims at the enemy;
    // the death2 spray (death211-222) walks flashes 2..13 with the blind
    // aimangles[] spray. The old `+ (frame % 13)` read the hold's frozen
    // frame index as a flash row, parking the live muzzle ~16u off the gun.
    flashId =
      ev.move === 'death2'
        ? MZ2_INFANTRY_MACHINEGUN_2 +
          Math.max(0, Math.min(11, ev.frame - INFANTRY_DEATH_SPRAY_FIRST_FRAME))
        : MZ2_INFANTRY_MACHINEGUN_1;
  }
  const chest = v3(m.edict.origin[0], m.edict.origin[1], m.edict.origin[2]! + 32);
  // True melee belongs to infantry only (m_infantry.c: attack2 frames into
  // infantry_smack, fire_hit dmg 5+(rand%5) kick 50, melee2.wav on connect;
  // the swing (infatck2.wav) plays at the wind-up frame, which the lite sim
  // collapses into the smack event). C fire_hit emits no muzzle flash,
  // dlight or tracer, so the smack resolves BEFORE the muzzle push and
  // stays flashless. Soldier/gunner melee is NULL in C — at melee range
  // they fire their guns point-blank, so non-infantry events fall through
  // to the gunfire branches below with the guns' real sounds.
  if (m.kind === 'infantry' && move === 'attack2') {
    if (dist < 96) {
      SV_DamagePlayer(st, infantryMeleeDamage(rand), m.edict.origin);
      st.sounds.push({ name: INFANTRY_MELEE_SOUND, pos: chest, born: st.time });
    }
    return;
  }
  const muzzle = projectSource(
    v3(m.edict.origin[0], m.edict.origin[1], m.edict.origin[2]),
    monsterFlashOffset(flashId),
    fwd,
    right,
  );
  const flashIdx = st.muzzles.length;
  st.muzzles.push({ pos: muzzle, intensity: 200 + ((rand() * 32) | 0), born: st.time, foe: true });
  const dirToEye = v3(eye[0]! - muzzle[0]!, eye[1]! - muzzle[1]!, eye[2]! - muzzle[2]!);
  const dirLen = Math.hypot(dirToEye[0]!, dirToEye[1]!, dirToEye[2]!) || 1;
  // Soldier blaster skin: a real projectile, not a damage roll.
  if (skinWeapon === 'blaster') {
    st.bolts.push({
      pos: v3(muzzle[0], muzzle[1], muzzle[2]),
      dir: v3(dirToEye[0]! / dirLen, dirToEye[1]! / dirLen, dirToEye[2]! / dirLen),
      life: 2,
      damage: SOLDIER_WEAPON_STATS.blaster.damage,
      speed: SOLDIER_WEAPON_STATS.blaster.boltSpeed,
      foe: true,
      born: st.time,
    });
    st.sounds.push({ name: SOLDIER_WEAPON_STATS.blaster.sound, pos: chest, born: st.time });
    return;
  }
  // Grenades leave the tube only on their C frames (105/108/111/114).
  if (move === 'attack_grenade' && ev.frame !== 4 && ev.frame !== 7 && ev.frame !== 10 && ev.frame !== 13) {
    st.muzzles.splice(flashIdx, 1);
    return;
  }
  const pHit = dist < 500 ? 0.6 : 0.25;
  // Infantry machinegun: single bullet per trigger (m_infantry.c
  // InfantryMachineGun -> monster_fire_bullet dmg 3 kick 4 spread 300/500,
  // infatck1.wav). The C AI_HOLD_FRAME hold re-fires this frame across
  // ticks for the remainder of the cock pausetime (4-19 rounds: the fire
  // frame plays 7 frames after the cock and the hold fires through the
  // expiry tick, so n-6 for the 10-25 cock window); the tick owns the
  // freeze (burstHoldFrozen), so each event resolves one bullet.
  // Attack1 aims at the enemy (with the -0.2 velocity lead folded into
  // the resolver's eye target); the death2 spray is blind — each round
  // leaves along angles - aimangles[] (see infantryDeathSprayAngles), so
  // the corpse's 12 streaks fan out instead of tracking the player.
  if (m.kind === 'infantry') {
    let shotDir = dirToEye;
    if (ev.move === 'death2') {
      const spray = v3();
      AngleVectors(infantryDeathSprayAngles(m.state.yaw, ev.frame), spray);
      shotDir = spray;
    }
    st.tracers.push({ origin: v3(muzzle[0], muzzle[1], muzzle[2]), dir: v3(shotDir[0], shotDir[1], shotDir[2]), color: HITSCAN_TRACER_COLOR, length: SERVER_ENEMY_TRACER_LENGTH, born: st.time });
    st.sounds.push({ name: INFANTRY_GUN_SOUND, pos: chest, born: st.time });
    if (rand() < pHit) {
      SV_DamagePlayer(st, INFANTRY_C.bulletDamage, m.edict.origin);
      st.sparks.push({ pos: v3(eye[0], eye[1], eye[2]), color: 200 + ((rand() * 55) | 0), vel: null, ttl: SV_SPARK_TTL, born: st.time });
    }
    return;
  }
  // Soldier machinegun skin: ONE bullet per trigger (m_soldier.c
  // soldier_fire4 -> monster_fire_bullet dmg 2 kick 4). The sustained
  // burst is the AI_HOLD_FRAME re-fire across 10Hz ticks (4-11 shots:
  // the arming tick plus k=3+rand()%8 frozen replays plus the expiry
  // replay), never a same-tick fan: each tick draws its own SHORT muzzle
  // streak (never a muzzle→eye beam) and rolls pHit once.
  if (skinWeapon === 'machinegun') {
    st.tracers.push({ origin: v3(muzzle[0], muzzle[1], muzzle[2]), dir: v3(dirToEye[0], dirToEye[1], dirToEye[2]), color: HITSCAN_TRACER_COLOR, length: SERVER_ENEMY_TRACER_LENGTH, born: st.time });
    st.sounds.push({ name: SOLDIER_WEAPON_STATS.machinegun.sound, pos: chest, born: st.time });
    if (rand() < pHit) {
      SV_DamagePlayer(st, SOLDIER_WEAPON_STATS.machinegun.damage, m.edict.origin);
      st.sparks.push({ pos: v3(eye[0], eye[1], eye[2]), color: 200 + ((rand() * 55) | 0), vel: null, ttl: SV_SPARK_TTL, born: st.time });
    }
    return;
  }
  let dmg = SOLDIER_WEAPON_STATS.shotgun.damage;
  let sound = SOLDIER_WEAPON_STATS.shotgun.sound;
  if (m.kind === 'gunner') {
    dmg = move === 'attack_grenade' ? 12 : 6;
    sound = move === 'attack_grenade' ? GUNNER_GRENADE_SOUND : 'gunner/gunatck2.wav';
  }
  st.tracers.push({ origin: v3(muzzle[0], muzzle[1], muzzle[2]), dir: v3(dirToEye[0], dirToEye[1], dirToEye[2]), color: HITSCAN_TRACER_COLOR, length: SERVER_ENEMY_TRACER_LENGTH, born: st.time });
  st.sounds.push({ name: sound, pos: chest, born: st.time });
  if (rand() < pHit) {
    SV_DamagePlayer(st, dmg, m.edict.origin);
    st.sparks.push({ pos: v3(eye[0], eye[1], eye[2]), color: 200 + ((rand() * 55) | 0), vel: null, ttl: SV_SPARK_TTL, born: st.time });
  }
}

/**
 * Nearest-hit bias for the touch resolution (id SV_ClipMoveToEntities ties
 * go to the world). Shared by the sky gate and the impact resolver so both
 * agree on who wins the step.
 */
const TOUCH_EPS = 1e-6;

interface BoltSweep {
  tPlayer: number | null;
  tMonster: number | null;
  hitMonster: ServerMonster | null;
  tBarrel: number | null;
  hb: ServerBarrel | null;
  /** Nearest misc_deadsoldier corpse (re-hit past -80 minces, g_misc.c). */
  tCorpse: number | null;
  hitCorpse: Edict | null;
}

/**
 * Sweep one bolt step against linked edicts (SV_ClipMoveToEntities half of
 * the C touch): nearest player-box hit for foe bolts, nearest monster +
 * barrel for player bolts. Dormant TRIGGER_SPAWN monsters are SOLID_NOT in
 * C and skip until woken; gibbed bodies are gone; corpses stay hittable.
 * misc_deadsoldier corpses (SOLID_BBOX 32x32x16, takedamage YES) join the
 * sweep so re-hitting them past -80 minces via SV_DamageDeadsoldier.
 */
function sweepBoltEntities(st: ServerState, bolt: ServerBolt, player: SVPlayerBody, seg: Vec3): BoltSweep {
  let tPlayer: number | null = null;
  if (bolt.foe) {
    // Soldier return fire: test the player box.
    const pmins = v3(player.pos[0]! + player.mins[0]!, player.pos[1]! + player.mins[1]!, player.pos[2]! + player.mins[2]!);
    const pmaxs = v3(player.pos[0]! + player.maxs[0]!, player.pos[1]! + player.maxs[1]!, player.pos[2]! + player.maxs[2]!);
    tPlayer = segmentAabbSeg(bolt.pos, seg, pmins, pmaxs);
  }
  let hitMonster: ServerMonster | null = null;
  let tMonster: number | null = null;
  if (!bolt.foe) {
    for (const m of st.monsters) {
      if (m.state.gibbed || (m.triggered && !m.woken)) continue;
      const maxs = monsterHullMaxs(m);
      const tHit = segmentAabbSeg(
        bolt.pos, seg,
        v3(m.edict.origin[0]! + MONSTER_HULL_MINS[0]!, m.edict.origin[1]! + MONSTER_HULL_MINS[1]!, m.edict.origin[2]! + MONSTER_HULL_MINS[2]!),
        v3(m.edict.origin[0]! + maxs[0]!, m.edict.origin[1]! + maxs[1]!, m.edict.origin[2]! + maxs[2]!),
      );
      if (tHit !== null && (tMonster === null || tHit < tMonster)) {
        tMonster = tHit;
        hitMonster = m;
      }
    }
  }
  let hb: ServerBarrel | null = null;
  let tBarrel: number | null = null;
  if (!bolt.foe) {
    for (const b of st.barrels) {
      if (b.edict.freed) continue;
      const tHit = b.isFunc
        ? segmentAabbSeg(bolt.pos, seg, v3(b.origin[0]! - b.size[0]! / 2, b.origin[1]! - b.size[1]! / 2, b.origin[2]! - b.size[2]! / 2), v3(b.origin[0]! + b.size[0]! / 2, b.origin[1]! + b.size[1]! / 2, b.origin[2]! + b.size[2]! / 2))
        : segmentAabbSeg(bolt.pos, seg, v3(b.origin[0]! + EXPLOBOX_MINS[0]!, b.origin[1]! + EXPLOBOX_MINS[1]!, b.origin[2]! + EXPLOBOX_MINS[2]!), v3(b.origin[0]! + EXPLOBOX_MAXS[0]!, b.origin[1]! + EXPLOBOX_MAXS[1]!, b.origin[2] + EXPLOBOX_MAXS[2]!));
      if (tHit !== null && (tBarrel === null || tHit < tBarrel)) {
        tBarrel = tHit;
        hb = b;
      }
    }
  }
  // Dead-soldier corpses (g_misc.c SP_misc_deadsoldier: SOLID_BBOX
  // 32x32x16 at the lump origin, takedamage YES at DEAD_DEAD): hittable
  // scenery, never freed. Only live edicts sweep (freed = picked-up item
  // edicts share the roster, never corpses).
  let hitCorpse: Edict | null = null;
  let tCorpse: number | null = null;
  if (!bolt.foe) {
    for (const e of st.entities) {
      if (e.freed || e.classname !== 'misc_deadsoldier') continue;
      const tHit = segmentAabbSeg(
        bolt.pos, seg,
        v3(e.origin[0]! - 16, e.origin[1]! - 16, e.origin[2]!),
        v3(e.origin[0]! + 16, e.origin[1]! + 16, e.origin[2]! + 16),
      );
      if (tHit !== null && (tCorpse === null || tHit < tCorpse)) {
        tCorpse = tHit;
        hitCorpse = e;
      }
    }
  }
  return { tPlayer, tMonster, hitMonster, tBarrel, hb, tCorpse, hitCorpse };
}

/**
 * Step flying blaster bolts. Life expires on SERVER time (G_FreeEdict at
 * level.time + 2); movement integrates the tick quantum. Foe bolts test the
 * player box and damage the player; player bolts test monsters first, then
 * barrels. Gibbed monsters are skipped, but corpses are NOT (takedamage YES
 * — re-hit minces via SV_DamageMonster).
 */
function stepBoltFlight(
  st: ServerState,
  player: SVPlayerBody,
  trace: TraceFn,
  rand: () => number,
  dt: number,
): void {
  if (st.bolts.length === 0) return;
  for (let i = st.bolts.length - 1; i >= 0; i--) {
    const bolt = st.bolts[i]!;
    const stepLen = bolt.speed * dt;
    const next = v3(
      bolt.pos[0]! + bolt.dir[0]! * stepLen,
      bolt.pos[1]! + bolt.dir[1]! * stepLen,
      bolt.pos[2]! + bolt.dir[2]! * stepLen,
    );
    // EF_BLASTER trail (cl_fx.c CL_BlasterTrail): yellow puffs every ~5u.
    // Touch order (g_phys.c SV_Physics_FlyMissile + SV_ClipMoveToEntities):
    // id traces the step against the world AND linked edicts together and
    // resolves the NEAREST hit — the old wall-first order detonated on any
    // wall inside the 100u step even when a barrel or monster stood closer
    // along the same segment (blaster could not kill barrels backed by a
    // wall, and foe bolts fizzled on doorframes past the player). The sky
    // gate (g_weapon.c blaster_touch) still frees silently, but only when
    // the wall actually wins the step: an edict in front of a sky face
    // still takes the hit, like C's tr.ent short-circuiting the surf check.
    let dead = st.time - bolt.born >= bolt.life;
    const wall = dead ? null : trace(bolt.pos, ZERO_HULL, ZERO_HULL, next);
    const seg = v3(next[0]! - bolt.pos[0]!, next[1]! - bolt.pos[1]!, next[2]! - bolt.pos[2]!);
    const sweep = sweepBoltEntities(st, bolt, player, seg);
    if (!dead && wall && wall.fraction < 1 && traceHitSky(wall)) {
      // Sky frees only when no edict beats the wall to the hit.
      const tWall = wall.fraction;
      const beaten =
        (sweep.tPlayer !== null && sweep.tPlayer < tWall - TOUCH_EPS) ||
        (sweep.tMonster !== null && sweep.tMonster < tWall - TOUCH_EPS) ||
        (sweep.tBarrel !== null && sweep.tBarrel < tWall - TOUCH_EPS);
      if (!beaten) dead = true;
    }
    if (dead) {
      st.bolts.splice(i, 1);
      continue;
    }
    const trailSteps = Math.min(8, Math.max(1, Math.round(stepLen / 5)));
    for (let k = 1; k <= trailSteps; k++) {
      const f = k / (trailSteps + 1);
      st.sparks.push({
        pos: v3(
          bolt.pos[0]! + (next[0]! - bolt.pos[0]!) * f,
          bolt.pos[1]! + (next[1]! - bolt.pos[1]!) * f,
          bolt.pos[2]! + (next[2]! - bolt.pos[2]!) * f,
        ),
        color: BLASTER_TRAIL_COLOR,
        vel: null,
        ttl: SV_SPARK_TTL,
        born: st.time,
      });
    }
    {
      // Nearest wins; ties fall through to the wall (the bolt face-plants
      // rather than phasing into the edict), matching the C trace bias.
      const tWall = wall!.fraction;
      const { tPlayer, tMonster, hitMonster, tBarrel, hb, tCorpse, hitCorpse } = sweep;
      const eps = TOUCH_EPS;
      if (tPlayer !== null && tPlayer < tWall - eps && (tMonster === null || tPlayer <= tMonster) && (tBarrel === null || tPlayer <= tBarrel)) {
        // Foe bolt vs player (g_weapon.c blaster_touch takedamage branch):
        // T_Damage only, no temp entity — C sends no TE_BLASTER here.
        if (st.playerHealth > 0) SV_DamagePlayer(st, bolt.damage, bolt.pos);
        dead = true;
      } else if (hitMonster !== null && tMonster !== null && tMonster < tWall - eps && (tBarrel === null || tMonster <= tBarrel) && (tCorpse === null || tMonster <= tCorpse)) {
        // Player bolt vs monster flesh: T_Damage only, no TE_BLASTER (C).
        // Impact height rides along for the soldier head-shot death branch.
        SV_DamageMonster(st, hitMonster, bolt.damage, rand, bolt.pos[2]! - hitMonster.edict.origin[2]!);
        dead = true;
      } else if (hb !== null && tBarrel !== null && tBarrel < tWall - eps && (tCorpse === null || tBarrel <= tCorpse)) {
        // Bolt vs shootable barrel (takedamage YES until fused): the fuse
        // latches, no impact flash in C (barrel_delay branch, no TE).
        SV_DamageBarrel(st, hb, bolt.damage);
        dead = true;
      } else if (hitCorpse !== null && tCorpse !== null && tCorpse < tWall - eps) {
        // Corpse touch (g_misc.c misc_deadsoldier_die via T_Damage): the
        // bolt minces past -80 (gibs + udeath) and dies either way — live
        // edicts win ties above, so scenery never shields a firefight.
        // No TE_BLASTER on takedamage (C blaster_touch): damage only.
        SV_DamageDeadsoldier(st, hitCorpse, bolt.damage, rand);
        dead = true;
      } else if (tWall < 1) {
        // Wall touch (g_weapon.c blaster_touch): everything non-sky
        // detonates via SV_BlasterImpact. When the winning wall face IS a
        // live func_explosive clip (SV_ClipTrace entityNum — C
        // SV_ClipMoveToEntities touches the SOLID_BSP edict itself), the
        // bolt also damages the brush: a func wall shot dead-on takes the
        // direct hit (barrel_delay fuse), not just the splash. Without this
        // the clip and the damage bbox tie exactly and the wall always wins,
        // leaving func_explosives undamageable by direct fire.
        const clipBarrel = barrelOfClip(st, wall!.entityNum);
        if (clipBarrel) SV_DamageBarrel(st, clipBarrel, bolt.damage);
        // C blaster_touch takedamage branch (g_weapon.c + g_func.c
        // button_killed): a bolt striking a health-gated func_button brush
        // damages the button instead of flashing — the lethal hit fires it.
        // Base1's *13 starts the exit lift this way in the original (E-use
        // is a driver convenience; Q2 has no +use-for-buttons); the port
        // previously sparked off it, leaving t91 unreachable by fire.
        // Health-less buttons (e.g. *34) fall through to the flash below.
        const hitButton = buttonOfClip(st, wall!.entityNum);
        if (hitButton && SV_DamageButton(st, hitButton, bolt.damage)) {
          dead = true;
        } else {
          const hitPos = v3(
            bolt.pos[0]! + (next[0]! - bolt.pos[0]!) * tWall,
            bolt.pos[1]! + (next[1]! - bolt.pos[1]!) * tWall,
            bolt.pos[2]! + (next[2]! - bolt.pos[2]!) * tWall,
          );
          // Wall touch (g_weapon.c blaster_touch, non-takedamage branch):
          // TE_BLASTER carries the plane normal (NULL plane -> zero vector).
          SV_BlasterImpact(st, hitPos, bolt.damage, null, rand, wall!.planeNormal ?? v3(0, 0, 0));
          dead = true;
        }
      }
    }
    if (dead) st.bolts.splice(i, 1);
    else bolt.pos = next;
  }
}

/**
 * Step debris + gibs (g_phys.c SV_Physics_Toss-lite): gravity, point-trace
 * move, ClipVelocity backoff (1.5 bounce debris / 1.0 toss gibs), floor rest
 * when vz < 60 and the plane normal is floor-like (> 0.7), life expiry
 * (5+rand*5 debris, 10+rand*10 gibs).
 */
function stepChunks(
  st: ServerState,
  items: Array<ServerDebris | ServerGib>,
  trace: TraceFn,
  dt: number,
  backoff: number,
): void {
  for (let i = items.length - 1; i >= 0; i--) {
    const c = items[i]!;
    if (st.time - c.born >= c.life) {
      items.splice(i, 1);
      continue;
    }
    if (c.rest) continue;
    c.vel[2] = c.vel[2]! - SV_TOSS_GRAVITY * dt;
    const next = v3(
      c.origin[0]! + c.vel[0]! * dt,
      c.origin[1]! + c.vel[1]! * dt,
      c.origin[2]! + c.vel[2]! * dt,
    );
    const hit = trace(c.origin, ZERO_HULL, ZERO_HULL, next);
    if (hit.fraction >= 1) {
      c.origin = next;
      continue;
    }
    c.origin = v3(
      c.origin[0]! + (next[0]! - c.origin[0]!) * hit.fraction,
      c.origin[1]! + (next[1]! - c.origin[1]!) * hit.fraction,
      c.origin[2]! + (next[2]! - c.origin[2]!) * hit.fraction,
    );
    const n = hit.planeNormal ?? v3(0, 0, 1);
    const d = (c.vel[0]! * n[0]! + c.vel[1]! * n[1]! + c.vel[2]! * n[2]!) * backoff;
    c.vel = v3(c.vel[0]! - n[0]! * d, c.vel[1]! - n[1]! * d, c.vel[2]! - n[2]! * d);
    if (n[2]! > 0.7 && (backoff < 1.5 || c.vel[2]! < 60)) {
      c.vel = v3();
      c.rest = true;
    }
  }
}

/**
 * P_WorldEffects drowning + sizzle (game/p_view.c) for the player pool:
 * samples the water at the player hull through the installed solid-aware
 * contents, applies the escalating drown / lava / slime damage through the
 * existing player-damage path, and emits the enter/exit/gasp/burn/drown
 * hooks through the existing positional-sound events. Skips when no map is
 * wired (devroom/asset-free paths have no water; air stays at grace).
 * The HUD air indicator reads st.playerAirLeft (no HUD files touched).
 * Timed suits (rebreather/envirosuit): C P_WorldEffects branches — active
 * while the Until timer exceeds level.time; protected air (air_finished =
 * time+10 while the head is under), breath sounds every 2.5s submerged,
 * envirosuit lava 3->1x + slime immunity, airout fade warning at <=3s.
 * HUD-exposed suit seconds land in playerBreatherLeft/playerEnviroLeft.
 */
function stepWorldEffects(st: ServerState, game: SVGameTick, rand: () => number): void {
  const contents = game.contents ?? SV_WorldContents;
  if (!contents) return;
  const p = game.player;
  const sample = sampleWaterLevel(p.pos, p.mins, p.view, contents);
  // C breather/enviro_framenum > level.framenum (level.time seconds here).
  const breather = st.time < st.playerBreatherUntil;
  const enviro = st.time < st.playerEnviroUntil;
  st.playerBreatherLeft = Math.max(0, st.playerBreatherUntil - st.time);
  st.playerEnviroLeft = Math.max(0, st.playerEnviroUntil - st.time);
  if ((breather || enviro) && sample.level === 3) {
    // C: breather || envirosuit give air — air_finished = level.time + 10.
    st.playerWorld.airFinished = Math.max(st.playerWorld.airFinished, st.time + SUIT_AIR_SECONDS);
  }
  const res = updateWorldEffects(
    st.playerWorld,
    { time: st.time, waterlevel: sample.level, watertype: sample.type, health: st.playerHealth },
    rand,
  );
  st.playerAirLeft = res.airLeft;
  // C sizzle with the envirosuit (lava 3->1x, slime immune): the pure helper
  // computes both, so subtract the suited difference. sample.type is the
  // pmove bit space (SLIME 4 / LAVA 8) — not the server q_shared consts.
  // (Drown damage is zero here — protected air never runs out — so
  // res.damage is pure sizzle and the adjustment is exact.)
  let damage = res.damage;
  if (enviro && sample.level > 0) {
    const inLava = (sample.type & PMOVE_CONTENTS_LAVA) !== 0;
    const inSlime = (sample.type & PMOVE_CONTENTS_SLIME) !== 0;
    damage = Math.max(
      0,
      damage - suitSizzleDamage(sample.level, inLava, inSlime, false) + suitSizzleDamage(sample.level, inLava, inSlime, true),
    );
  }
  if (damage > 0) SV_DamagePlayer(st, damage);
  // C P_WorldEffects hooks first (enter/exit/gasp/gurp, in C order), then
  // the suit extras below (breath lives in the drown block, airout in the
  // later blend pass).
  for (const name of res.sounds) {
    // C S_RegisterSexedSound (client/snd_dma.c): `*gurpN` resolves through
    // the player model, defaulting to male (player/male/gurpN.wav) — the
    // `*` never names a pak lump, so emit the resolved concrete name.
    const resolved =
      name === '*gurp1.wav' ? 'player/male/gurp1.wav' : name === '*gurp2.wav' ? 'player/male/gurp2.wav' : name;
    st.sounds.push({ name: resolved, pos: v3(p.pos[0], p.pos[1], p.pos[2]), born: st.time });
  }
  // C breath sounds while submerged+protected: every 25 frames, alternating
  // u_breath1/2 (C client->breather_sound ^= 1; anchored to remaining
  // framenums there, to a 2.5s schedule here — same audible cadence).
  if ((breather || enviro) && sample.level === 3 && st.time >= st.nextBreathAt) {
    const snd = st.breathToggle ? SUIT_BREATH_SOUNDS[1]! : SUIT_BREATH_SOUNDS[0]!;
    st.sounds.push({ name: snd, pos: v3(p.pos[0], p.pos[1], p.pos[2]), born: st.time });
    st.breathToggle = !st.breathToggle;
    st.nextBreathAt = st.time + SUIT_BREATH_PERIOD;
  }
  // C fade warning (p_view.c blend block): items/airout.wav once per arming
  // at 30 frames (3s) remaining.
  if (st.playerBreatherLeft > SUIT_WARN_SECONDS) st.breatherWarned = false;
  else if (breather && !st.breatherWarned) {
    st.sounds.push({ name: SUIT_WARN_SOUND, pos: v3(p.pos[0], p.pos[1], p.pos[2]), born: st.time });
    st.breatherWarned = true;
  }
  if (st.playerEnviroLeft > SUIT_WARN_SECONDS) st.enviroWarned = false;
  else if (enviro && !st.enviroWarned) {
    st.sounds.push({ name: SUIT_WARN_SOUND, pos: v3(p.pos[0], p.pos[1], p.pos[2]), born: st.time });
    st.enviroWarned = true;
  }
}

/**
 * Phase 0 gameplay phase of SV_Tick: monster think with C cadence fire
 * resolution, monster door touches, bolt flight + touch, barrel fuses,
 * debris/gibs and explosion pruning (all at 10Hz on server time).
 */
function SV_GameTick(st: ServerState, game: SVGameTick, dt: number): void {
  const rand = game.rand ?? Math.random;
  const sightTrace = game.sightTrace ?? game.trace;
  // Monsters use doors (Touch_DoorTrigger; NOMONSTER sliders ignore them).
  for (const m of st.monsters) {
    if (m.state.dead || m.state.gibbed || (m.triggered && !m.woken) || m.kind === null) continue;
    SV_TouchDoorsAt(st, { origin: m.edict.origin, mins: MONSTER_HULL_MINS, maxs: MONSTER_HULL_MAXS }, 'monster');
  }
  // Think + C-cadence return fire (damage, bolts, tracers, muzzles, sounds).
  for (const ev of SV_MonsterTick(st, game.player.pos, game.trace, game.nav ?? null, rand, { sightTrace, playerViewheight: game.player.view, playerBody: { mins: game.player.mins, maxs: game.player.maxs } })) {
    const m = st.monsters.find((mm) => mm.edict.num === ev.num);
    if (!m) continue;
    resolveMonsterFire(st, m, ev, game.player, rand);
  }
  // Bolts fly and touch.
  stepBoltFlight(st, game.player, game.trace, rand, dt);
  // Barrel fuses / target_explosion delays blow on server time.
  for (let i = st.fuses.length - 1; i >= 0; i--) {
    const f = st.fuses[i]!;
    if (st.time < f.at) continue;
    st.fuses.splice(i, 1);
    if (f.barrel) {
      spawnBarrelDebris(st, f.barrel, rand);
      // C func_explosive_explode fires the brush target (G_UseTargets)
      // between the radius damage and the free: base1's *20 glass shatter
      // plays t78 (world/brkglas.wav) from here. Fire before freeing, as C.
      if (f.barrel.edict.target) fireTargets(st, f.barrel.edict);
      // C BecomeExplosion1/G_FreeEdict: the brush frees the same tick its
      // clip drops, so the vanished mesh and the opened hole stay atomic —
      // no freed-but-solid window for bodies to collide with.
      f.barrel.edict.freed = true;
      // The brush is gone (func_explosive_explode / BecomeExplosion free the
      // edict either way): open the clip so the hole stays open.
      if (f.barrel.isFunc) SV_RemoveBrushClip(st, f.barrel.edict);
      // C guards BOTH the T_RadiusDamage and the BecomeExplosion1 behind
      // `if (self->dmg)`: a damageless brush (*20 glass, dmg 0) throws
      // debris, fires its target and frees — no flash, no sound, no radius.
      // (misc_explobox always carries its 150 default, so it always booms.)
      if (f.barrel.dmg > 0) {
        SV_SpawnExplosion(st, f.pos, f.dmg, { trace: game.trace, rand });
        SV_RadiusDamage(st, f.pos, f.dmg, game.player, game.trace, rand);
      }
      continue;
    }
    SV_SpawnExplosion(st, f.pos, f.dmg, { trace: game.trace, rand });
    SV_RadiusDamage(st, f.pos, f.dmg, game.player, game.trace, rand);
  }
  // P_WorldEffects drowning + sizzle (game/p_view.c).
  stepWorldEffects(st, game, rand);
  // Tossed chunks fall and rest; visuals live their full frame life.
  stepChunks(st, st.debris, game.trace, dt, 1.5);
  stepChunks(st, st.gibs, game.trace, dt, 1.0);
  for (let i = st.explosions.length - 1; i >= 0; i--) {
    const e = st.explosions[i]!;
    const frames = explosionFrames(e.kind);
    if (st.time - e.born >= frames * 0.1) st.explosions.splice(i, 1);
  }
  // Safety prune: undrained one-shot queues never grow across frames.
  // Loop-channel entries persist (C s.sound lives on the edict until
  // toggled) — neither pruned here nor drained below.
  const wipe = (q: Array<{ born: number }>): void => {
    for (let i = q.length - 1; i >= 0; i--) {
      if (st.time - q[i]!.born > 5) q.splice(i, 1);
    }
  };
  wipe(st.muzzles);
  wipe(st.tracers);
  wipe(st.sparks);
  for (let i = st.sounds.length - 1; i >= 0; i--) {
    const s = st.sounds[i]!;
    if (s.loop !== true && st.time - s.born > 5) st.sounds.splice(i, 1);
  }
}

/** Drain the pending muzzle flashes (one-shot dlight pump). */
export function SV_DrainMuzzles(st: ServerState): ServerMuzzle[] {
  if (st.muzzles.length === 0) return [];
  const out = st.muzzles.slice();
  st.muzzles.length = 0;
  return out;
}

/** Drain the pending tracer beams (short muzzle streaks). */
export function SV_DrainTracers(st: ServerState): ServerTracer[] {
  if (st.tracers.length === 0) return [];
  const out = st.tracers.slice();
  st.tracers.length = 0;
  return out;
}

/** Drain the pending particle-burst requests (impacts, trails, booms). */
export function SV_DrainSparks(st: ServerState): ServerSpark[] {
  if (st.sparks.length === 0) return [];
  const out = st.sparks.slice();
  st.sparks.length = 0;
  return out;
}

/** Drain the pending positional-sound requests (loop channels persist). */
export function SV_DrainSounds(st: ServerState): ServerSound[] {
  if (st.sounds.length === 0) return [];
  const out = st.sounds.filter((s) => s.loop !== true);
  st.sounds = st.sounds.filter((s) => s.loop === true);
  return out;
}

/** Drain the pending centerprint lines (G_UseTargets message branch). */
export function SV_DrainCenterprints(st: ServerState): string[] {
  if (st.centerprints.length === 0) return [];
  const out = st.centerprints.slice();
  st.centerprints.length = 0;
  return out;
}

/** Player fire inputs (computed by the driver from its input state). */
export interface SVFireOpts {
  eye: Vec3;
  feet: Vec3;
  angles: Vec3;
  /** Standing eye height (22; the bolt spawn offset keys off it). */
  viewheight: number;
  /** Current reserve for the weapon's ammo kind (ignored for blaster). */
  ammo: number;
  /** World trace (C-mask via SV_TraceFor; wrap in SV_ClipTrace for clips). */
  trace: TraceFn;
  /** Caller-seeded RNG (spread, muzzle radius, gibs). */
  rand: () => number;
  /**
   * Brown-water surface query (C g_weapon.c fire_lead
   * `strcmp(tr.surface->name, "*brwater")`): when a pellet stops in WATER
   * contents, true maps to the brown splash class, false to blue. Sampled
   * just inside the water volume along the shot. Absent = legacy behavior
   * (WATER always blue). Backed by `bspBrownWaterFor` in @q2/game for real
   * maps; tests inject synthetic true/false. Optional so existing callers
   * and frozen TraceFn/TraceResult shapes are untouched.
   */
  brownWaterAt?: (p: Vec3) => boolean;
  /**
   * Pre-trigger machinegun burst count (client->machinegun_shots, p_weapon.c
   * Machinegun_Fire). The driver owns the counter across ticks; default 0
   * (fresh trigger pull). Ignored for non-machinegun weapons.
   */
  machinegunShots?: number;
}

/** Player fire outcome (ammo sync for the driver's HUD state). */
export interface SVFireResult {
  fired: boolean;
  reason: string;
  ammoLeft: number;
  /** True when a player bolt was spawned (authentic fire_blaster). */
  bolt: boolean;
  /**
   * Latched post-trigger burst count (C: shots+1 clamped at 9 in SP).
   * Echoes the input when the weapon is not the machinegun or the trigger
   * did not fire, so the driver can store it back verbatim.
   */
  machinegunShots?: number;
  /** Per-shot kick_origin (id client->kick_origin), machinegun only. */
  kickOrigin?: Vec3;
  /** Per-shot kick_angles (id client->kick_angles), machinegun only. */
  kickAngles?: Vec3;
}

/**
 * Weapon-noise wake-up (g_ai.c FindTarget heardit half + PlayerNoise).
 * Called once per player shot; see the SV_PlayerFire call site for the
 * C mapping. `opts.trace` doubles as the ambush visibility check.
 */
export function playerNoiseWake(st: ServerState, opts: SVFireOpts): void {
  for (const m of st.monsters) {
    if (m.kind === null || m.state.dead || m.state.gibbed) continue;
    if (m.triggered && !m.woken) continue;
    if (m.seen) continue;
    const dx = opts.feet[0]! - m.edict.origin[0]!;
    const dy = opts.feet[1]! - m.edict.origin[1]!;
    const dz = opts.feet[2]! - m.edict.origin[2]!;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) > 1000) continue;
    if (m.ambush) {
      // Spawnflags & 1 hears only what it can see (C heardit ambush gate).
      const a = v3(m.edict.origin[0], m.edict.origin[1], m.edict.origin[2]! + MONSTER_VIEWHEIGHT);
      const t = opts.trace(a, ZERO_HULL, ZERO_HULL, opts.eye);
      if (t.fraction !== 1 || t.startsolid) continue;
    }
    m.seen = true;
    m.reactionAt = -1;
    // Hunt the noise position (C acquires the sound entity): steer the
    // trail pursuit at the firing feet until sight takes over.
    m.state.lastSighting[0] = opts.feet[0]!;
    m.state.lastSighting[1] = opts.feet[1]!;
    m.state.lastSighting[2] = opts.feet[2]!;
    m.state.trailTime = st.time;
  }
}

/**
 * Per-trigger fire sound (client/cl_fx.c CL_ParseMuzzleFlash MZ_* cases —
 * the client plays these on the muzzle flash, which is the sound slot
 * SV_PlayerFire feeds). Machinegun/chaingun rotate machgf1-5b
 * (Com_sprintf "weapons/machgf%ib.wav", (rand()%5)+1); the legacy fixed
 * machgf1b for the machinegun is kept (driver pins depend on it).
 */
export function playerFireSound(weaponKind: string, rand: () => number): string {
  switch (weaponKind) {
    case 'weapon_shotgun':
      return 'weapons/shotgf1b.wav';
    case 'weapon_supershotgun':
      return 'weapons/sshotf1b.wav';
    case 'weapon_machinegun':
      return 'weapons/machgf1b.wav';
    case 'weapon_chaingun':
      return `weapons/machgf${1 + ((rand() * 5) | 0)}b.wav`;
    case 'weapon_grenades':
      return 'weapons/hgrena1b.wav';
    case 'weapon_grenadelauncher':
      return 'weapons/grenlf1a.wav';
    case 'weapon_rocketlauncher':
      return 'weapons/rocklf1a.wav';
    case 'weapon_hyperblaster':
      return 'weapons/hyprbf1a.wav';
    case 'weapon_railgun':
      return 'weapons/railgf1a.wav';
    case 'weapon_bfg':
      return 'weapons/bfg__f1y.wav';
    default:
      return 'weapons/blastf1a.wav';
  }
}

/**
 * SV_PlayerFire: the driver computes the shot (eye/feet/angles from input)
 * but the server applies it — ammo, muzzle dlight, foe/player bolts,
 * hitscan pellet traces vs wall/monsters/barrels, pain/gib/barrel damage,
 * impact sparks and sounds. Returns the ammo sync for the driver.
 *
 * Authentic split (g_weapon.c): the blaster is a PROJECTILE weapon
 * (fire_blaster bolt edict, 1000 u/s, 2s life, EF_BLASTER trail) — never
 * hitscan, never a muzzle->impact beam. Hitscan weapons (shotgun /
 * machinegun, fire_lead) are instant traces with impact sparks only.
 */
export function SV_PlayerFire(
  st: ServerState,
  weaponKind: string,
  opts: SVFireOpts,
): SVFireResult {
  const def = findWeapon(weaponKind);
  if (!def) return { fired: false, reason: 'no weapon', ammoLeft: opts.ammo, bolt: false };
  const res = fireWeapon(def, opts.ammo, opts.rand, false);
  if (!res.fired) {
    st.sounds.push({ name: 'weapons/noammo.wav', pos: v3(opts.eye[0], opts.eye[1], opts.eye[2]), born: st.time });
    return { fired: false, reason: res.reason, ammoLeft: res.ammoLeft, bolt: false, machinegunShots: opts.machinegunShots ?? 0 };
  }
  const fwd = v3();
  const right = v3();
  const up = v3();
  AngleVectors(opts.angles, fwd, right, up);
  st.sounds.push({
    name: playerFireSound(weaponKind, opts.rand),
    pos: v3(opts.eye[0], opts.eye[1], opts.eye[2]),
    born: st.time,
  });
  // Weapon noise (g_ai.c FindTarget heardit half): firing stamps
  // show_hostile (near-range rear sight for 1s) and wakes listeners — every
  // non-ambush body within 1000u (C gi.inPHS approximated by range; the sim
  // has no PHS set), ambush bodies only when the muzzle is visible to them.
  // Woken bodies hunt the noise position via the trail (lastSighting), like
  // C acquiring the sound entity.
  st.lastPlayerShotAt = st.time;
  playerNoiseWake(st, opts);
  // Muzzle flash: HUD glow + a real dlight (id CL_MuzzleFlash: origin =
  // feet + fwd*18 + right*16, radius 200+(rand&31), pure yellow).
  st.muzzles.push({
    pos: blasterMuzzle(opts.feet, fwd, right),
    intensity: muzzleRadius(opts.rand),
    born: st.time,
    foe: false,
  });
  // Machinegun per-shot kick walk (p_weapon.c Machinegun_Fire): the driver
  // owns machinegun_shots across ticks and passes the pre-trigger count in;
  // the latched count + kick vectors come back for the view/weapon kick.
  let machinegunShots = opts.machinegunShots ?? 0;
  let kickOrigin: Vec3 | undefined;
  let kickAngles: Vec3 | undefined;
  if (weaponKind === 'weapon_machinegun') {
    const kick = machinegunKick(machinegunShots, opts.rand);
    kickOrigin = kick.kickOrigin;
    kickAngles = kick.kickAngles;
    machinegunShots = kick.shots;
  }
  // Authentic blaster: G_ProjectSource from the feet (start = feet +
  // fwd*24 + right*8, z += viewheight-8). The bolt leaves the gun muzzle.
  // Hull-swept spawn (Phase 2): when the muzzle plants inside solid
  // (point-blank at a wall seam/doorframe), C fire_blaster would pull the
  // bolt back 10 and touch-detonate — a wasted shot + face flash. Eject the
  // spawn forward to the first free point instead so a legal shot leaves the
  // gun; only a muzzle buried past the eject cap detonates C-style.
  if (weaponKind === 'weapon_blaster' && res.bolt) {
    const start = blasterSpawn(opts.feet, fwd, right, opts.viewheight);
    const dl = Math.hypot(fwd[0]!, fwd[1]!, fwd[2]!) || 1;
    const dir = v3(fwd[0]! / dl, fwd[1]! / dl, fwd[2]! / dl);
    // C check_dodge (g_weapon.c): projectile weapons only — the soldier in
    // the shot line may duck or duck-and-shoot (skill odds) with eta from
    // the bolt speed. Hitscan (shotgun/machinegun) never triggers this.
    checkDodges(st, opts.eye, dir, st.skill, opts.trace, opts.rand, BOLT_SPEED);
    const spawn = resolveBoltSpawn(opts.trace, dir, start);
    if (spawn.embedded) {
      // C fire_blaster pullback: touch with a NULL plane (no trace plane
      // reaches this path) -> TE_BLASTER carries the zero vector.
      SV_BlasterImpact(st, start, res.bolt.damage, null, opts.rand, v3(0, 0, 0));
      return { fired: true, reason: 'ok', ammoLeft: res.ammoLeft, bolt: false, machinegunShots };
    }
    st.bolts.push({
      pos: spawn.pos,
      dir,
      life: res.bolt.life,
      damage: res.bolt.damage,
      speed: BOLT_SPEED,
      foe: false,
      born: st.time,
    });
    return { fired: true, reason: 'ok', ammoLeft: res.ammoLeft, bolt: true, machinegunShots };
  }
  for (const pl of res.pellets) {
    const dir = v3(
      fwd[0]! * SV_PELLET_RANGE + right[0]! * pl.r + up[0]! * pl.u,
      fwd[1]! * SV_PELLET_RANGE + right[1]! * pl.r + up[1]! * pl.u,
      fwd[2]! * SV_PELLET_RANGE + right[2]! * pl.r + up[2]! * pl.u,
    );
    const len = Math.hypot(dir[0]!, dir[1]!, dir[2]!) || 1;
    const far = v3(
      opts.eye[0]! + ((dir[0]! / len) * SV_PELLET_RANGE),
      opts.eye[1]! + ((dir[1]! / len) * SV_PELLET_RANGE),
      opts.eye[2]! + ((dir[2]! / len) * SV_PELLET_RANGE),
    );
    const wall = opts.trace(opts.eye, ZERO_HULL, ZERO_HULL, far);
    let bestT = wall.fraction;
    let hitMonster: ServerMonster | null = null;
    const seg = v3(far[0]! - opts.eye[0]!, far[1]! - opts.eye[1]!, far[2]! - opts.eye[2]!);
    for (const m of st.monsters) {
      if (m.state.gibbed || (m.triggered && !m.woken)) continue;
      // No dead-skip: corpses stay hittable (takedamage YES) so re-hitting
      // them minces (g_combat.c T_Damage gib-first ordering). Dormant
      // TRIGGER_SPAWN bodies skip (SOLID_NOT until woken). Ducking soldiers
      // present the C duck hull (maxs z 0 — chest-aimed shots pass over).
      const maxs = monsterHullMaxs(m);
      const tHit = segmentAabbSeg(
        opts.eye, seg,
        v3(m.edict.origin[0]! + MONSTER_HULL_MINS[0]!, m.edict.origin[1]! + MONSTER_HULL_MINS[1]!, m.edict.origin[2]! + MONSTER_HULL_MINS[2]!),
        v3(m.edict.origin[0]! + maxs[0]!, m.edict.origin[1]! + maxs[1]!, m.edict.origin[2]! + maxs[2]!),
      );
      if (tHit !== null && tHit < bestT) {
        bestT = tHit;
        hitMonster = m;
      }
    }
    const hitPos = v3(
      opts.eye[0]! + seg[0]! * bestT,
      opts.eye[1]! + seg[1]! * bestT,
      opts.eye[2]! + seg[2]! * bestT,
    );
    // Barrels are shootable (misc_explobox takes T_Damage): test the shot
    // path against live barrels before resolving the wall/monster hit.
    let hitBarrel: ServerBarrel | null = null;
    let barrelT = bestT;
    for (const b of st.barrels) {
      if (b.edict.freed) continue;
      const tHit = b.isFunc
        ? segmentAabbSeg(opts.eye, seg, v3(b.origin[0]! - b.size[0]! / 2, b.origin[1]! - b.size[1]! / 2, b.origin[2]! - b.size[2]! / 2), v3(b.origin[0]! + b.size[0]! / 2, b.origin[1]! + b.size[1]! / 2, b.origin[2]! + b.size[2]! / 2))
        : segmentAabbSeg(opts.eye, seg, v3(b.origin[0]! + EXPLOBOX_MINS[0]!, b.origin[1]! + EXPLOBOX_MINS[1]!, b.origin[2]! + EXPLOBOX_MINS[2]!), v3(b.origin[0]! + EXPLOBOX_MAXS[0]!, b.origin[1]! + EXPLOBOX_MAXS[1]!, b.origin[2]! + EXPLOBOX_MAXS[2]!));
      if (tHit !== null && tHit < barrelT) {
        barrelT = tHit;
        hitBarrel = b;
      }
    }
    // Dead-soldier corpses (g_misc.c SP_misc_deadsoldier: SOLID_BBOX
    // 32x32x16 at the lump origin, takedamage YES): hittable scenery, same
    // nearest-wins rule as the bolt path (live edicts win ties).
    let hitCorpse: Edict | null = null;
    let corpseT = bestT;
    for (const e of st.entities) {
      if (e.freed || e.classname !== 'misc_deadsoldier') continue;
      const tHit = segmentAabbSeg(
        opts.eye, seg,
        v3(e.origin[0]! - 16, e.origin[1]! - 16, e.origin[2]!),
        v3(e.origin[0]! + 16, e.origin[1]! + 16, e.origin[2]! + 16),
      );
      if (tHit !== null && tHit < corpseT) {
        corpseT = tHit;
        hitCorpse = e;
      }
    }
    if (hitBarrel && !hitBarrel.edict.freed && barrelT <= corpseT) {
      SV_DamageBarrel(st, hitBarrel, pl.damage);
    } else if (hitMonster && bestT <= corpseT) {
      SV_DamageMonster(st, hitMonster, pl.damage, opts.rand, hitPos[2]! - hitMonster.edict.origin[2]!);
      // C g_combat.c:490 T_Damage → SpawnDamage(TE_BLOOD, point, normal,
      // take): monster/client flesh draws blood, not a gray puff. The gib
      // path is untouched (SV_DamageMonster owns it); blaster flesh stays
      // event-free per the lane's takedamage-branch decision (no TE there).
      for (let i = 0; i < 8; i++) {
        st.sparks.push({
          pos: v3(
            hitPos[0]! + ((opts.rand() * 8) | 0) - 4,
            hitPos[1]! + ((opts.rand() * 8) | 0) - 4,
            hitPos[2]! + ((opts.rand() * 8) | 0) - 4,
          ),
          color: 0xe8 + ((opts.rand() * 8) | 0),
          vel: v3((opts.rand() * 2 - 1) * 60, (opts.rand() * 2 - 1) * 60, opts.rand() * 120),
          ttl: 0.5 + opts.rand() * 0.3,
          born: st.time,
          blood: true,
        });
      }
    } else if (hitCorpse) {
      // Corpse touch (g_misc.c misc_deadsoldier_die via T_Damage): minces
      // past -80 (gibs + udeath). Impact sparks draw at the corpse hit
      // point (corpseT < bestT: the shared hitPos sits past the corpse).
      SV_DamageDeadsoldier(st, hitCorpse, pl.damage, opts.rand);
      st.sparks.push({
        pos: v3(
          opts.eye[0]! + seg[0]! * corpseT,
          opts.eye[1]! + seg[1]! * corpseT,
          opts.eye[2]! + seg[2]! * corpseT,
        ),
        color: 200 + ((opts.rand() * 55) | 0),
        vel: null,
        ttl: SV_SPARK_TTL,
        born: st.time,
      });
    } else if (bestT < 1) {
      // TE_GUNSHOT / TE_SHOTGUN impact: gray sparks + smoke, no beam.
      // Same SOLID_BSP touch rule as the bolt path: a pellet stopping on a
      // live func_explosive clip damages the brush (dead-on shotgun blasts
      // blow the wall), with the impact sparks drawn either way.
      const clipBarrel = barrelOfClip(st, wall.entityNum);
      if (clipBarrel) SV_DamageBarrel(st, clipBarrel, pl.damage);
      // C g_weapon.c fire_lead water branch: a pellet stopping in water
      // (BSP contents WATER/SLIME/LAVA, the space traceBox reports) draws
      // TE_SPLASH — 8 particles in the contents color — instead of a dry
      // puff. Brown is a surface-name property ("*brwater") with no channel
      // in TraceResult, so the WATER branch resolves it through the optional
      // `brownWaterAt` surface query (sampled just inside the volume along
      // the shot; the trace endpos sits on the entry plane in the air leaf).
      // Absent query = legacy blue. SLIME/LAVA stay contents-driven.
      const wc = wall.contents;
      let splashKind: WaterSplashKind | null = null;
      if (wc & BSP_WATER_BIT) {
        let brown = false;
        if (opts.brownWaterAt) {
          const segLen = Math.hypot(seg[0]!, seg[1]!, seg[2]!) || 1;
          const sample = v3(
            hitPos[0]! + (seg[0]! / segLen) * 0.5,
            hitPos[1]! + (seg[1]! / segLen) * 0.5,
            hitPos[2]! + (seg[2]! / segLen) * 0.5,
          );
          try {
            brown = opts.brownWaterAt(sample) ?? false;
          } catch {
            brown = false;
          }
        }
        splashKind = brown ? 'brown' : 'blue';
      } else if (wc & BSP_SLIME_BIT) splashKind = 'slime';
      else if (wc & BSP_LAVA_BIT) splashKind = 'lava';
      if (splashKind !== null) {
        const base =
          splashKind === 'blue' ? 0xb0 : splashKind === 'brown' ? 0x50 : splashKind === 'slime' ? 0xd0 : 0xe0;
        for (let i = 0; i < 8; i++) {
          st.sparks.push({
            pos: v3(
              hitPos[0]! + ((opts.rand() * 8) | 0) - 4,
              hitPos[1]! + ((opts.rand() * 8) | 0) - 4,
              hitPos[2]! + ((opts.rand() * 8) | 0) - 4,
            ),
            color: base + ((opts.rand() * 8) | 0),
            vel: null,
            ttl: 0.5 + opts.rand() * 0.3,
            born: st.time,
            splash: splashKind,
          });
        }
      } else {
        st.sparks.push({
          pos: hitPos,
          color: 200 + ((opts.rand() * 55) | 0),
          vel: null,
          ttl: SV_SPARK_TTL,
          born: st.time,
        });
      }
    }
  }
  return { fired: true, reason: 'ok', ammoLeft: res.ammoLeft, bolt: false, machinegunShots, kickOrigin, kickAngles };
}
