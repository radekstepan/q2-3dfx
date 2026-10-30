// q2ts-web GPU-FOLLOW-3 live-effects inventory + per-frame helpers (apps/web only).
//
// Lane-B module for the FOLLOW-3 card: the actual live producers/consumers
// for sprites, particles, beams, explosions, lights and model/skin kinds,
// and the per-frame wiring the live GPU loop (`frameGpuPlay` in play.ts)
// uses to connect game events and lifetimes to GPU drawing.
//
// Inventory (verified against packages/server + packages/game + the pak):
//
// | effect      | live producer (server/driver)                              | GPU consumer                              |
// | ----------- | -------------------------------------------------------- | ----------------------------------------- |
// | bolts       | server.bolts (SV_PlayerFire player 1000u/s, foe 600u/s)   | alias entity (bolt MD2) + yellow dlight   |
// | muzzles     | server.muzzles one-shot (SV_DrainMuzzles, per-tick)        | driver flashPending/enemyFlashes → dlights|
// | tracers     | server.tracers one-shot (SV_DrainTracers, per-tick)       | driver tracerQueue → beam entities        |
// | sparks      | server.sparks one-shot (SV_DrainSparks, per-tick)         | driver mini.particles pool (TTL stepped)  |
// | explosions  | server.explosions live list (frame life, pruned server-side)| alias entity (explode/blast MD2) + dlight |
// | debris/gibs | server.debris/gibs live lists (toss physics)               | alias entities (debris/gib MD2s)          |
// | particles   | mini.particles (sparks above; base1 seeds ZERO)            | renderer POINTS (caps at 256)             |
// | sprites     | NONE on the live path (no server sprite queue; base1     | renderer sprite quads (supported, idle)   |
// |             | world sprites 0; pak ships 8 sp2 but nothing registers     |                                           |
// |             | them — gap for the server/renderer lanes, not apps/web)    |                                           |
// | lights      | muzzle + enemy muzzle + explosion + per-bolt (per-frame)  | GpuLight[<=8] to renderFrame              |
// | monsters    | server.monsters (soldier/infantry live in base1; gunner    | alias entities (per-kind MD2 + skinnum    |
// |             | mesh registered, no live gunner — roster fact, not a bug)  | skin for soldiers)                       |
// | pickups     | server.entities item_/weapon_/ammo_ (skill-filtered)       | alias entities (world-model MD2s, spin)   |
// | viewmodel   | driver weapon state (Weapon_Generic-lite gunframe)         | depthHack alias entity (v_weap MD2)       |
// | sky/water   | world surfaces (base1: 128 sky, 102 turbulent, 17          | sky fill + turbulent/opaque + blend pass  |
// | /glass      | transparent; ALL 102 turbulent also carry translucent)     | (combined flags classify turbulent — the  |
// |             |                                                            | blend-pass fix owns packages/webgl-renderer)|
//
// Drain order (single-drain rule): every server one-shot queue is drained
// exactly once per server tick at the END of LocalDriver.step (via
// drainServerEvents: muzzles → tracers → sparks → sounds), and every driver
// one-shot queue is drained exactly once per GPU frame at the START of
// frameGpuPlay (flash → enemy muzzle → explosion window → bolts → tracers)
// BEFORE stepAsyncSim runs the next tick. A second drain of the same queue
// in the same tick/frame always yields nothing — drops and double-consumes
// both fail the follow3 tests.
import type { Entity, GpuSceneInput } from '@q2/renderer-api';
import type { GpuEntityModelKind } from '@q2/webgl-renderer';
import type { MiniWorld } from '@q2/sw-renderer';
import type { PakModelHandles, PlayBoot, TracerBeam } from './play.js';

/** Server one-shot queues, in the per-tick drain order drainServerEvents uses. */
export const EFFECT_DRAIN_ORDER = ['muzzles', 'tracers', 'sparks', 'sounds'] as const;

/** One inventory row: a live effect, its producer, and its GPU consumer. */
export interface EffectInventoryRow {
  effect: string;
  producer: string;
  consumer: string;
  /** False when the live path currently feeds nothing (documented gap). */
  live: boolean;
}

/** Structured FOLLOW-3 inventory (see the module header table). */
export function describeEffectInventory(): EffectInventoryRow[] {
  return [
    { effect: 'bolts', producer: 'server.bolts live list (SV_PlayerFire)', consumer: 'alias entity (bolt MD2) + GpuLight 200 yellow', live: true },
    { effect: 'muzzles', producer: 'server.muzzles one-shot per tick (SV_DrainMuzzles)', consumer: 'driver flashPending/enemyFlashes → GpuLight [1,1,0]', live: true },
    { effect: 'tracers', producer: 'server.tracers one-shot per tick (monster shotgun/machinegun return fire; player pellets spark only)', consumer: 'driver tracerQueue → beam entities (tracer kind)', live: true },
    { effect: 'sparks', producer: 'server.sparks one-shot per tick (SV_DrainSparks)', consumer: 'driver mini.particles pool, TTL-stepped per tick', live: true },
    { effect: 'explosions', producer: 'server.explosions live list (frame life, server-pruned)', consumer: 'alias entity (explode/blast MD2, framelerp+alpha) + GpuLight', live: true },
    { effect: 'debris', producer: 'server.debris live list (ThrowDebris toss physics)', consumer: 'alias entities (debris1/2/3 MD2s)', live: true },
    { effect: 'gibs', producer: 'server.gibs live list (ThrowGib/ThrowHead toss physics)', consumer: 'alias entities (meat/chest/bone/head MD2s)', live: true },
    { effect: 'particles', producer: 'mini.particles pool (spark bursts; base1 seeds 0)', consumer: 'renderer POINTS (collectParticlePoints, cap 256)', live: true },
    { effect: 'sprites', producer: 'NONE on the live path (no server sprite queue)', consumer: 'renderer sprite quads 48x48 (supported, idle)', live: false },
    { effect: 'lights', producer: 'muzzle + enemy muzzle + explosion window + per-bolt', consumer: 'GpuLight[] (MAX 8) to renderFrame per frame', live: true },
    { effect: 'monsters', producer: 'server.monsters (base1 live: soldier, infantry)', consumer: 'alias entities (per-kind MD2 + soldier skinnum skin)', live: true },
    { effect: 'pickups', producer: 'server.entities item_/weapon_/ammo_ (skill-filtered)', consumer: 'alias entities (world-model MD2s, EF_ROTATE spin)', live: true },
    { effect: 'viewmodel', producer: 'driver weapon state (Weapon_Generic-lite gunframe)', consumer: 'depthHack alias entity (v_weap MD2 + skin)', live: true },
    { effect: 'sky', producer: 'world sky surfaces (base1: 128)', consumer: 'renderer sky fill pass (flat, no texture)', live: true },
    { effect: 'turbulent', producer: 'world turbulent surfaces (base1: 102, all also translucent)', consumer: 'opaque-batch turbulent draw (unwarped; blend fix owns renderer)', live: true },
    { effect: 'transparent', producer: 'world translucent surfaces (base1: 17 glass)', consumer: 'blend pass far->near with order keys', live: true },
  ];
}

/** Negative model-handle base for synthesized beam entities (never collides). */
export const BEAM_HANDLE_BASE = -1000;

/** Muzzle/bolt dynamic-light color (id yellow [1,1,0] spirit). */
export const MUZZLE_LIGHT_COLOR: [number, number, number] = [1, 1, 0];
/** Per-bolt dlight radius (matches the frameGpuPlay mapping). */
export const BOLT_LIGHT_INTENSITY = 200;
/** Blaster-touch explosion dlight radius scale (× alpha). */
export const BLASTER_LIGHT_INTENSITY = 150;
/** Big-boom explosion dlight radius scale (× alpha). */
export const BOOM_LIGHT_INTENSITY = 350;
/** Big-boom dlight color (warm [1,0.5,0.5] spirit). */
export const BOOM_LIGHT_COLOR: [number, number, number] = [1, 0.5, 0.5];

/**
 * Full per-frame model-kind map (FOLLOW-3 metadata preservation): every
 * retained asset handle keeps its registered kind (md2/sp2/tracer — today
 * all md2, but the map no longer depends on that), and every synthesized
 * beam handle is marked 'tracer'. frameGpuPlay passes this to BOTH
 * refreshGpuScene (selection) and setEntities (draw dispatch) so the two
 * agree; unknown handles still default to 'alias' downstream.
 */
export function modelKindsForFrame(
  models: PakModelHandles | null,
  beamModels: Iterable<number>,
): Map<number, GpuEntityModelKind> {
  const kinds = new Map<number, GpuEntityModelKind>();
  if (models) {
    for (const m of models.assets.models) {
      if (m.kind === 'md2' || m.kind === 'sp2' || m.kind === 'tracer') {
        kinds.set(m.handle, m.kind);
      }
    }
  }
  for (const h of beamModels) kinds.set(h, 'tracer');
  return kinds;
}

/**
 * Synthesize contract-free beam entities from drained tracer beams
 * (origin = start, angles = dir, frame = length, skin = palette color —
 * the `resolveBeam` convention the renderer reads). Handles count down
 * from BEAM_HANDLE_BASE (-1000 - i), mirroring frameGpuPlay exactly.
 */
export function synthesizeBeamEntities(tracers: TracerBeam[]): {
  entities: Entity[];
  kinds: Map<number, GpuEntityModelKind>;
} {
  const kinds = new Map<number, GpuEntityModelKind>();
  const entities: Entity[] = tracers.map((t, i) => {
    const model = BEAM_HANDLE_BASE - i;
    kinds.set(model, 'tracer');
    return {
      model,
      origin: new Float32Array([t.origin[0]!, t.origin[1]!, t.origin[2]!]),
      angles: new Float32Array([t.dir[0]!, t.dir[1]!, t.dir[2]!]),
      frame: t.length,
      skin: t.color,
    } as Entity;
  });
  return { entities, kinds };
}

/** World-material census over a live MiniWorld (degenerate NODRAW excluded). */
export interface WorldMaterialCensus {
  sky: number;
  turbulent: number;
  /** Turbulent AND translucent (base1 water/glass overlap — the combined-flags case). */
  turbulentTranslucent: number;
  transparent: number;
  opaque: number;
}

/** Count live world surfaces by material class (pure, headless-safe). */
export function censusWorldMaterials(mini: MiniWorld): WorldMaterialCensus {
  const out: WorldMaterialCensus = { sky: 0, turbulent: 0, turbulentTranslucent: 0, transparent: 0, opaque: 0 };
  for (const s of mini.surfaces) {
    if (!s || s.n < 3) continue;
    if (s.sky) {
      out.sky++;
      continue;
    }
    if (s.turbulent) {
      out.turbulent++;
      const t = s.translucent ?? 0;
      if (t === 1 || t === 2) out.turbulentTranslucent++;
      continue;
    }
    const t = s.translucent ?? 0;
    if (t === 1 || t === 2) out.transparent++;
    else out.opaque++;
  }
  return out;
}

/** Submitted-scene census by material (world refs + entity refs). */
export interface SceneMaterialCensus {
  worldOpaque: number;
  worldTransparent: number;
  sky: number;
  turbulent: number;
  sprite: number;
  alias: number;
  beam: number;
  particle: number;
}

/** Count submitted scene refs by material (pure, headless-safe). */
export function censusSceneMaterials(scene: GpuSceneInput): SceneMaterialCensus {
  const out: SceneMaterialCensus = {
    worldOpaque: 0, worldTransparent: 0, sky: 0, turbulent: 0,
    sprite: 0, alias: 0, beam: 0, particle: 0,
  };
  for (const r of scene.surfaces) {
    if (r.transformIndex === 0) {
      if (r.material === 'sky') out.sky++;
      else if (r.material === 'turbulent') out.turbulent++;
      else if (r.transparent) out.worldTransparent++;
      else out.worldOpaque++;
      continue;
    }
    if (r.material === 'sprite') out.sprite++;
    else if (r.material === 'beam') out.beam++;
    else if (r.material === 'particle') out.particle++;
    else out.alias++;
  }
  return out;
}

/**
 * True when every transparent ref in the submitted scene sorts far->near
 * (non-increasing order keys — the blend-pass contract refreshGpuScene
 * promises for world + entity transparent refs combined).
 */
export function isBlendOrderSorted(scene: GpuSceneInput): boolean {
  let last = Infinity;
  for (const r of scene.surfaces) {
    if (!r.transparent) continue;
    if (r.order > last) return false;
    last = r.order;
  }
  return true;
}

/**
 * Live combat/effects state for observability (soak `__q2soakRoute.effects`
 * AND the follow3 tests share this reader — one definition, no drift).
 * Never throws: every section degrades to its sentinel.
 */
export interface LiveEffects {
  /** Flying bolts right now (player + foe). */
  bolts: number;
  /** Live explosions right now (any kind). */
  explosions: number;
  /** Kinds of the live explosions (e.g. ['blaster']). */
  explosionKinds: string[];
  /** Particles pooled in mini.particles right now. */
  particles: number;
  /** Renderer POINTS cap (collectParticlePoints truncates past this). */
  particleCap: number;
  /** Beams queued but not yet submitted this frame. */
  pendingTracers: number;
  /** Muzzle flash inside its 0.09s dlight window. */
  muzzleLit: boolean;
  /** Pending muzzle-flash radius (200 before the first shot). */
  flashIntensity: number;
  /** Server-owned one-shot queues still holding events (should be 0 post-drain). */
  serverQueues: { muzzles: number; tracers: number; sparks: number; sounds: number };
  /** Live (non-dead, non-gibbed) monsters. */
  aliveMonsters: number;
  /** Distinct live monster kinds. */
  monsterKinds: string[];
  /** Live skill-kept pickups. */
  pickups: number;
  /** Weapon_Generic-lite gunframe for the selected weapon. */
  gunframe: number;
  /** True while a lower/raise switch blocks fire. */
  weaponSwitching: boolean;
  /** World-material census (sky/turbulent/transparent/opaque). */
  world: WorldMaterialCensus | null;
  /** Submitted-scene census (last frame; null without a GPU boot). */
  scene: SceneMaterialCensus | null;
  /** Blend-pass order contract holds on the last submitted scene. */
  blendSorted: boolean | null;
}

/** Read live combat/effects state off a boot (pure reader, never throws). */
export function readLiveEffects(boot: PlayBoot): LiveEffects {
  const sentinel: LiveEffects = {
    bolts: -1, explosions: -1, explosionKinds: [], particles: -1, particleCap: 256,
    pendingTracers: -1, muzzleLit: false, flashIntensity: 200,
    serverQueues: { muzzles: -1, tracers: -1, sparks: -1, sounds: -1 },
    aliveMonsters: -1, monsterKinds: [], pickups: -1, gunframe: -1,
    weaponSwitching: false, world: null, scene: null, blendSorted: null,
  };
  try {
    const d = boot.driver;
    sentinel.bolts = d.bolts.length;
    sentinel.explosions = d.explosions.length;
    try {
      sentinel.explosionKinds = [...new Set(d.explosions.map((e) => String(e.kind)))].sort();
    } catch {
      sentinel.explosionKinds = [];
    }
    sentinel.particles = d.mini.particles.length;
    sentinel.pendingTracers = d.pendingTracers;
    try {
      sentinel.muzzleLit = d.muzzleLit();
    } catch {
      sentinel.muzzleLit = false;
    }
    try {
      sentinel.flashIntensity = d.peekFlashIntensity();
    } catch {
      sentinel.flashIntensity = 200;
    }
    try {
      const st = d.server;
      sentinel.serverQueues = {
        muzzles: st.muzzles.length, tracers: st.tracers.length,
        sparks: st.sparks.length, sounds: st.sounds.length,
      };
    } catch {
      sentinel.serverQueues = { muzzles: -1, tracers: -1, sparks: -1, sounds: -1 };
    }
    sentinel.aliveMonsters = d.aliveMonsters;
    try {
      const kinds = new Set<string>();
      for (const m of d.monsters) {
        if (!m.state.dead) kinds.add(String(m.state.kind));
      }
      sentinel.monsterKinds = [...kinds].sort();
    } catch {
      sentinel.monsterKinds = [];
    }
    try {
      sentinel.pickups = d.livePickupCount();
    } catch {
      sentinel.pickups = -1;
    }
    try {
      sentinel.gunframe = d.gunFrame;
      sentinel.weaponSwitching = d.weaponSwitching;
    } catch {
      /* hooks best-effort */
    }
    try {
      sentinel.world = censusWorldMaterials(d.mini);
    } catch {
      sentinel.world = null;
    }
    try {
      if (boot.gpu) {
        sentinel.scene = censusSceneMaterials(boot.gpu.scene);
        sentinel.blendSorted = isBlendOrderSorted(boot.gpu.scene);
      }
    } catch {
      sentinel.scene = null;
      sentinel.blendSorted = null;
    }
  } catch {
    /* sentinel stands */
  }
  return sentinel;
}
