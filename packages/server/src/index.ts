// @q2/server — SV_: world state, entity spawning, 10Hz tick. M5.2 owns this.
// In-process server: SV_Tick advances level.time by SERVER_DT (0.1s) and
// runs entities (movers, triggers). Quake coords/angles per BRAIN.md §5.

import { SERVER_DT } from '@q2/config';
import {
  DoRespawn,
  SetRespawn,
  doorTravel,
  moverThink,
  moverUse,
  parseEntities,
  parseFloat,
  respawnDelayFor,
  resetEdictNums,
  spawnButton,
  spawnDoor,
  spawnEdict,
  spawnPlat,
  spawnTrigger,
  triggerTouch,
} from '@q2/game';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import type { Edict, Mover, Trigger } from '@q2/game';

export interface ServerState {
  /** level.time in seconds (float). Never wall-clock. */
  time: number;
  entities: Edict[];
  movers: Mover[];
  triggers: Trigger[];
  /** fired targetnames this tick (test/diagnostics hook) */
  firedThisTick: string[];
  /** per-tick mover displacement by edict num (SV_Push rider carrying) */
  moverDeltas: Map<number, Vec3>;
  /** brush-model bounds by mover edict num (for rider stand tests) */
  moverBounds: Map<number, { mins: Float32Array; maxs: Float32Array }>;
}

export function SV_Init(): ServerState {
  return { time: 0, entities: [], movers: [], triggers: [] as Trigger[], firedThisTick: [], moverDeltas: new Map(), moverBounds: new Map() };
}

/** Link an edict into the world (SV_LinkEdict: register + solid bookkeeping). */
export function SV_LinkEdict(st: ServerState, e: Edict): void {
  if (!st.entities.includes(e)) st.entities.push(e);
}

export function SV_SpawnMover(st: ServerState, m: Mover): void {
  SV_LinkEdict(st, m.ent);
  st.movers.push(m);
}

export function SV_SpawnTrigger(st: ServerState, t: Trigger): void {
  SV_LinkEdict(st, t.ent);
  st.triggers.push(t);
}

/**
 * Spawn a full entities lump: creates edicts for every block and wires
 * movers/triggers for the classes base1 needs. Unknown classes are kept as
 * plain edicts (decorations, lights, monster placeholders).
 *
 * `modelSizes` is the WIRE hook for id-correct door travel: SP_func_door
 * computes travel as |movedir| . brushSize - lip from the brush model bounds,
 * which only the BSP side knows. When a model resolves, its size-based travel
 * is used; otherwise the legacy `distance`-key default (128) applies.
 */
export function SV_SpawnEntities(
  st: ServerState,
  text: string,
  modelSizes?: (model: string) => { mins: Float32Array; maxs: Float32Array } | null,
): Edict[] {
  resetEdictNums();
  const out: Edict[] = [];
  for (const dict of parseEntities(text)) {
    const e = spawnEdict(dict);
    SV_LinkEdict(st, e);
    out.push(e);
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
      case 'func_plat':
        SV_SpawnMover(st, spawnPlat(e, parseFloat(dict['height'], 160)));
        break;
      case 'func_button': {
        const m = spawnButton(e, angle);
        SV_SpawnMover(st, m);
        const model = dict['model'];
        if (modelSizes && model) {
          const bounds = modelSizes(model);
          if (bounds) st.moverBounds.set(e.num, { mins: bounds.mins, maxs: bounds.maxs });
        }
        break;
      }
      case 'trigger_once':
      case 'trigger_multiple':
        SV_SpawnTrigger(st, spawnTrigger(e));
        break;
      default:
        break;
    }
  }
  return out;
}

/** Fire a "use" on every entity with the given targetname (button/trigger path). */
export function SV_UseTargetname(st: ServerState, targetname: string): void {
  for (const m of st.movers) {
    if (m.ent.targetname === targetname) moverUse(m, st.time);
  }
  for (const e of st.entities) {
    if (e.targetname === targetname && e.classname === 'trigger_relay') {
      fireTargets(st, e);
    }
  }
}

/** G_UseTargets equivalent: use every entity targeted by `user`. */
export function fireTargets(st: ServerState, user: Edict): void {
  if (!user.target) return;
  for (const e of st.entities) {
    if (e.freed || e.targetname !== user.target) continue;
    st.firedThisTick.push(e.targetname);
    const m = st.movers.find((mm) => mm.ent === e);
    if (m) moverUse(m, st.time);
  }
}

/** Touch all triggers as `toucherClass` at `origin` (point-in-tests hook). */
export function SV_TouchTriggersAt(
  st: ServerState,
  toucherClass: 'player' | 'monster',
  toucher: Edict,
): void {
  for (const t of st.triggers) {
    if (t.ent.freed) continue;
    // proximity check: within the trigger's bbox expanded by 8 units
    const dx = toucher.origin[0]! - t.ent.origin[0]!;
    const dy = toucher.origin[1]! - t.ent.origin[1]!;
    const dz = toucher.origin[2]! - t.ent.origin[2]!;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > 96 * 96) continue;
    triggerTouch(t, st.time, toucherClass, (tt) => {
      const pseudo: Edict = { ...tt.ent };
      fireTargets(st, pseudo);
    });
  }
}

/**
 * Advance the world by dt seconds (default SERVER_DT = 0.1, 10Hz).
 * Runs movers to completion legs, records per-mover displacement for
 * rider carrying, respawns due pickups, and clears per-tick diagnostics.
 */
export function SV_Tick(st: ServerState, dt: number = SERVER_DT): void {
  st.firedThisTick = [];
  st.time += dt;
  const now = st.time;
  const before = new Map<number, Vec3>();
  for (const m of st.movers) {
    if (m.ent.freed) continue;
    before.set(m.ent.num, v3(m.ent.origin[0], m.ent.origin[1], m.ent.origin[2]));
  }
  for (const m of st.movers) {
    if (m.ent.freed) continue;
    moverThink(m, now);
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
  // Pickup respawn (DoRespawn): re-materialize hidden items whose timer
  // (SetRespawn via SV_ConsumePickup) elapsed on level.time.
  for (const e of st.entities) {
    if (!e.freed && e.extra['respawnAt'] !== undefined) {
      DoRespawn(e, now);
    }
  }
}

/**
 * Consume a pickup edict the way Touch_Item does after a successful grab:
 * hide it (SOLID_NOT) and arm the id respawn timer (SetRespawn, ~30s for
 * weapons/health/ammo, 20s for armor). SV_Tick re-materializes it via
 * DoRespawn. `delay` overrides the id table; `now` defaults to level.time.
 */
export function SV_ConsumePickup(st: ServerState, ent: Edict, delay?: number, now?: number): number {
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
 * tick (id g_phys.c: riders move with the pusher). Matches C semantics
 * exactly — only groundEntity == pusher links ride; world-grounded and
 * airborne bodies are untouched. Must run after SV_Tick (reads
 * moverDeltas) and before the bodies' own movement for the tick.
 */
export function SV_CarryRiders(st: ServerState, bodies: RiderBody[]): void {
  for (const b of bodies) {
    if (!b.onGround || b.groundEntity < 0) continue;
    const d = st.moverDeltas.get(b.groundEntity);
    if (!d) continue;
    b.origin[0] = b.origin[0]! + d[0]!;
    b.origin[1] = b.origin[1]! + d[1]!;
    b.origin[2] = b.origin[2]! + d[2]!;
  }
}
