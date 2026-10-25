// @q2/server — SV_: world state, entity spawning, 10Hz tick. M5.2 owns this.
// In-process server: SV_Tick advances level.time by SERVER_DT (0.1s) and
// runs entities (movers, triggers). Quake coords/angles per BRAIN.md §5.

import { SERVER_DT } from '@q2/config';
import {
  doorTravel,
  moverThink,
  moverUse,
  parseEntities,
  parseFloat,
  resetEdictNums,
  spawnButton,
  spawnDoor,
  spawnEdict,
  spawnPlat,
  spawnTrigger,
  triggerTouch,
} from '@q2/game';
import type { Edict, Mover, Trigger } from '@q2/game';

export interface ServerState {
  /** level.time in seconds (float). Never wall-clock. */
  time: number;
  entities: Edict[];
  movers: Mover[];
  triggers: Trigger[];
  /** fired targetnames this tick (test/diagnostics hook) */
  firedThisTick: string[];
}

export function SV_Init(): ServerState {
  return { time: 0, entities: [], movers: [], triggers: [] as Trigger[], firedThisTick: [] };
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
          }
        }
        SV_SpawnMover(st, spawnDoor(e, angle, distance));
        break;
      }
      case 'func_plat':
        SV_SpawnMover(st, spawnPlat(e, parseFloat(dict['height'], 160)));
        break;
      case 'func_button':
        SV_SpawnMover(st, spawnButton(e, angle));
        break;
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
 * Runs movers to completion legs and clears per-tick diagnostics.
 */
export function SV_Tick(st: ServerState, dt: number = SERVER_DT): void {
  st.firedThisTick = [];
  st.time += dt;
  const now = st.time;
  for (const m of st.movers) {
    if (m.ent.freed) continue;
    moverThink(m, now);
  }
}
