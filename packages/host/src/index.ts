// @q2/host — the loop tying server+client+renderer (M6.1/M7.1).
//
// Owns the frame loop: accumulate wall time, tick the server at 10Hz
// (gracefully degrading when @q2/server has no world sim yet), feed client
// snapshots into the Predictor, and render through any Refresh backend.
// Everything heavy is injected; this file only glues.
import { SERVER_DT, getCVarNumber } from '@q2/config';
import type { Framebuffer, Refresh, RefDef, WorldModel, FrameStats, Entity } from '@q2/renderer-api';
import { createFramebuffer, devroomWorld } from '@q2/renderer-api';
import { Predictor, GameConsole, Configstrings, calcViewOrigin } from '@q2/client';
import type { Snapshot, PredictCmd } from '@q2/client';

import { Mixer } from '@q2/sound';
import { createInput, buildUserCmd } from '@q2/input';
import type { InputCore, UserCmdT } from '@q2/input';

export interface HostOptions {
  refresh: Refresh;
  width?: number;
  height?: number;
  /** software path framebuffer carries the 8-bit index plane */
  indexed?: boolean;
  localPlayerId?: number;
  world?: WorldModel;
  /** Real-play simulation. Absent = synthetic offline/devroom mode. */
  driver?: HostDriver;
}

/**
 * Server-authoritative play simulation owned by the app layer.
 *
 * The Host owns time, input->cmd, snapshots and rendering; the driver owns
 * the world: spawning, per-tick simulation (pmove, movers, triggers,
 * monsters) and authoritative entity snapshots. Keeps @q2/host free of
 * @q2/server/@q2/game imports while making the game actually playable.
 */
export interface HostDriver {
  /** Player start (info_player_start or devroom default). */
  spawn(): { origin: [number, number, number]; angles?: [number, number, number] };
  /** Advance the simulation by dt seconds (server tick quantum). */
  step(cmd: UserCmdT, dt: number): void;
  /** Authoritative entities at serverTime (must include localPlayerId). */
  snapshot(serverTime: number): Snapshot;
  /**
   * First-person weapon view model (camera-attached 3D gun). Null hides it
   * (2D fallback or no gun). The driver owns model/skin handles + anim.
   */
  viewModel?(): { model: number; skin: number; frame: number } | null;
  /**
   * MD2 frame for a snapshot entity (monster move table first + offset).
   * Defaults to 0 when absent. The renderer wraps out-of-range indices.
   */
  entityFrame?(id: number): number;
  /**
   * World orientation [pitch, yaw, roll] for a snapshot entity (monster
   * facing, bolt flight dir). Absent/null → [0,0,0] (legacy behaviour).
   */
  entityAngles?(id: number): [number, number, number] | null | undefined;
  /**
   * Model/skin handles for a snapshot entity (soldier vs gunner vs bolt).
   * Absent/null → { model: 0, skin: 0 } (legacy behaviour).
   */
  entityModel?(id: number): { model: number; skin: number } | null | undefined;
  /**
   * One-tick camera kick offset (RF/gunoffset-lite: id applies the weapon
   * kick in game/p_weapon.c and the gun offset in game/p_view.c
   * `SV_CalcGunOffset` — pitch/yaw/roll delta plus eye-offset delta).
   * Added to the RefDef angles/origin in renderCurrentView; the driver
   * clears it next tick (returns null) so it lands on exactly one frame.
   */
  viewKick?(): { angles: [number, number, number]; origin: [number, number, number] } | null;
  /**
   * Sway/turn-lag added to the viewmodel entity angles (RF/gunoffset-lite:
   * the driver computes the SV_CalcGunOffset-lite term — 0.2*delta
   * turn-lag ±45 clamp + speed-scaled bob sway; static when still).
   * Added to the full view angles on the eye-anchored gun entity.
   */
  gunAnglesDelta?(): [number, number, number] | null;
  /**
   * Extra world entities the snapshot omits (flying bolts, live barrels,
   * explosion flashes). Absent/null → none. Plain data, no web imports.
   */
  extraEntities?(): ExtraRenderable[] | null | undefined;
}

/**
 * One extra world entity (bolt / barrel / explosion flash). Only `origin`
 * is required; everything else falls back to the snapshot-entity defaults
 * (angles [0,0,0], model 0, skin 0, frame 0).
 */
export interface ExtraRenderable {
  origin: [number, number, number];
  angles?: [number, number, number];
  model?: number;
  skin?: number;
  frame?: number;
}

/**
 * View-model forward offset, in world units.
 *
 * Faithful to id `CL_AddViewWeapon` (client/cl_ents.c): the gun origin is
 * `vieworg + gunoffset` with `gun_x/y/z` defaulting to 0 (game/g_main.c),
 * and the gun angles are the full `viewangles + gunangles` — i.e. the gun
 * sits AT the eye, oriented with the view (pitch included). It stays
 * visible because the alias backend Sutherland-clips straddling tris at
 * the near plane (r_aclip.c `R_ClipPolyPlane`, `ALIAS_Z_CLIP_PLANE`)
 * instead of dropping them, and the gun entity carries RF_DEPTHHACK
 * (`Entity.depthHack`, ref_soft `s_ziscale *= 3`). Kept as a named
 * constant (0 = eye anchor, no push) so tests and drivers can pin it.
 */
export const VIEWMODEL_FORWARD = 0;

export class Host {
  readonly fb: Framebuffer;
  readonly refresh: Refresh;
  readonly predictor = new Predictor();
  readonly console = new GameConsole();
  readonly configstrings = new Configstrings();
  readonly mixer = new Mixer();
  readonly input: InputCore = createInput();
  world: WorldModel;
  localPlayerId: number;
  readonly driver: HostDriver | null;
  serverTime = 0;
  lastCmd: UserCmdT | null = null;
  private serverAcc = 0;
  private lastNow = -1;
  /**
   * Owned cmds since the newest acked snapshot, replayed through pmove by
   * the Predictor (friction-exact local prediction instead of linear
   * extrapolation). Cleared on every ingested snapshot, extended every
   * frame after lastCmd is built — so it always ends with the current cmd.
   */
  private ownedCmds: PredictCmd[] = [];
  /** Synthetic local-player state for devroom/offline mode. */
  playerOrigin: [number, number, number] = [0, 0, 0];
  playerVelocity: [number, number, number] = [0, 0, 0];

  constructor(opts: HostOptions) {
    const width = opts.width ?? 320;
    const height = opts.height ?? 240;
    this.refresh = opts.refresh;
    this.fb = createFramebuffer(width, height, opts.indexed ?? true);
    this.refresh.init(this.fb);
    this.world = opts.world ?? devroomWorld();
    this.localPlayerId = opts.localPlayerId ?? 1;
    this.driver = opts.driver ?? null;
    if (this.driver) {
      const spawn = this.driver.spawn();
      this.playerOrigin = [...spawn.origin] as [number, number, number];
      if (spawn.angles) this.input.angles = [...spawn.angles] as [number, number, number];
    }
  }

  /** Server tick via the attached driver when present, else advance time only. */
  private serverTick(dt: number): void {
    this.serverTime += dt;
    if (!this.driver) return;
    const cmd: UserCmdT = this.lastCmd ?? {
      msec: Math.max(1, Math.round(dt * 1000)),
      angles: [...this.input.angles] as [number, number, number],
      forwardmove: 0,
      sidemove: 0,
      upmove: 0,
      buttons: 0,
    };
    this.driver.step(cmd, dt);
  }

  /** Feed an authoritative snapshot (server -> client). */
  ingestSnapshot(snap: Snapshot): void {
    this.predictor.pushSnapshot(snap);
    // New acked state: drop the replayed stream (rebuilt below each frame).
    this.ownedCmds = [];
    this.predictor.clearPendingCmds();
  }

  /** Build a devroom/offline snapshot from local synthetic state. */
  private offlineSnapshot(): Snapshot {
    return {
      serverTime: this.serverTime,
      entities: [
        { id: this.localPlayerId, origin: [...this.playerOrigin], velocity: [...this.playerVelocity] },
      ],
    };
  }

  /**
   * Advance one host frame. `nowMs` is wall-clock milliseconds.
   * Returns render stats.
   */
  frame(nowMs: number): FrameStats {
    if (this.lastNow < 0) this.lastNow = nowMs;
    let dt = (nowMs - this.lastNow) / 1000;
    this.lastNow = nowMs;
    if (!(dt >= 0) || dt > 0.25) dt = 0.016;

    // Client command FIRST from accumulated input, so server ticks below
    // already see this frame's release/press. The old order ticked with the
    // previous frame's cmd, running one extra 100ms move on stale input
    // after stopping — a forward overshoot + snap-back that felt like
    // hitting a wall (the stop jitter). Ticks still quantize at 10Hz.
    const msec = Math.max(1, Math.round(dt * 1000));
    this.lastCmd = buildUserCmd(this.input, msec, {
      sensitivity: getCVarNumber('sensitivity') || 3,
      mYaw: getCVarNumber('m_yaw') || 0.022,
      mPitch: getCVarNumber('m_pitch') || 0.022,
    });

    // Fixed-step server ticks at 10Hz.
    this.serverAcc += dt;
    while (this.serverAcc >= SERVER_DT) {
      this.serverAcc -= SERVER_DT;
      this.serverTick(SERVER_DT);
      if (this.driver) {
        const snap = this.driver.snapshot(this.serverTime);
        this.ingestSnapshot(snap);
        const local = snap.entities.find((e) => e.id === this.localPlayerId);
        if (local) {
          this.playerOrigin = [...local.origin] as [number, number, number];
          this.playerVelocity = [...local.velocity] as [number, number, number];
        }
      } else {
        this.ingestSnapshot(this.offlineSnapshot());
      }
    }
    // Stage the owned cmd stream (since the newest snapshot, ending with
    // the current frame's cmd) so the local player predicts through the
    // friction-exact pmove replay instead of constant-velocity
    // extrapolation — the old path overshot after stopping (stale
    // velocity) and snapped back on the next tick. Remote entities keep
    // interp delay (untouched).
    if (this.lastCmd) {
      this.ownedCmds.push({
        msec: this.lastCmd.msec,
        angles: [...this.lastCmd.angles],
        forwardmove: this.lastCmd.forwardmove,
        sidemove: this.lastCmd.sidemove,
        upmove: this.lastCmd.upmove,
        buttons: this.lastCmd.buttons,
      });
      if (this.ownedCmds.length > 120) this.ownedCmds.splice(0, this.ownedCmds.length - 120);
      this.predictor.setPendingCmds(this.ownedCmds);
    }
    // Offline prediction: integrate the synthetic player with the cmd.
    // Skipped when a driver owns the simulation (its snapshot is authoritative).
    if (!this.driver && getCVarNumber('cl_predict') !== 0 && this.lastCmd) {
      const step = msec / 1000;
      this.playerVelocity[0] = this.lastCmd.forwardmove * 0.5;
      this.playerVelocity[1] = this.lastCmd.sidemove * 0.5;
      this.playerOrigin[0] += this.playerVelocity[0] * step;
      this.playerOrigin[1] += this.playerVelocity[1] * step;
    }

    return this.renderCurrentView();
  }

  /** Render the current predicted/interpolated view. */
  renderCurrentView(): FrameStats {
    // Continuous render clock: serverTime only advances on 10Hz ticks, so
    // add the sub-tick remainder. Passing the stepped serverTime here would
    // freeze the camera between ticks (slideshow) while the angles (fresh
    // from lastCmd every frame) stay smooth.
    const now = this.serverTime + this.serverAcc;
    const entities = this.predictor.renderEntities(now, this.localPlayerId);
    // Local player comes from the Predictor (interpolated/predicted at `now`),
    // not from playerOrigin, which only refreshes from driver.snapshot() on
    // ticks. Offline mode (no driver) keeps playerOrigin: it is already
    // integrated per-frame in frame(), so the predictor's 100ms-delayed
    // snapshots would only add lag there.
    let base: [number, number, number] = this.playerOrigin;
    if (this.driver) {
      const local = entities.find((e) => e.id === this.localPlayerId);
      if (local) base = local.origin;
    }
    const viewBase: [number, number, number] = this.lastCmd
      ? [this.lastCmd.angles[0], this.lastCmd.angles[1], this.lastCmd.angles[2]]
      : [0, 0, 0];
    // One-tick camera kick (p_weapon.c kick via p_view.c SV_CalcGunOffset):
    // added to the RefDef angles/origin; the driver returns null next tick.
    const kick = this.driver?.viewKick?.() ?? null;
    const angles: [number, number, number] = kick
      ? [viewBase[0] + kick.angles[0], viewBase[1] + kick.angles[1], viewBase[2] + kick.angles[2]]
      : viewBase;
    // Single duck state (Phase 3): the eye follows the authoritative pmove
    // hull (driver pm.viewheight), not the raw cmd bit — the bit flips
    // instantly (airborne holds, headroom-blocked stands) while PM_CheckDuck
    // owns the transition. Feature-detected: drivers without a pm fall back
    // to the legacy cmd-bit rule (offline mode behavior is unchanged).
    const drvPm = (this.driver as unknown as { pm?: { viewheight?: unknown } } | null)?.pm;
    const drvView = typeof drvPm?.viewheight === 'number' ? drvPm.viewheight : null;
    // Standing height 22 (VIEW_HEIGHT in @q2/client); anything else is ducked.
    const ducked = drvView !== null ? drvView !== 22 : (this.lastCmd ? (this.lastCmd.buttons & 8) !== 0 || this.lastCmd.upmove < 0 : false);
    let eye = calcViewOrigin(base, ducked);
    if (kick) eye = [eye[0] + kick.origin[0], eye[1] + kick.origin[1], eye[2] + kick.origin[2]];
    const view: RefDef = {
      origin: new Float32Array(eye) as RefDef['origin'],
      angles: new Float32Array(angles) as RefDef['angles'],
      fovX: 90,
      time: this.serverTime,
      lightStyles: new Float32Array(256).fill(1),
    };
    const renderables: Entity[] = entities
      // Never draw the local player's own body (it sits at the camera).
      .filter((e) => e.id !== this.localPlayerId)
      .map((e) => {
        // Per-entity yaw/model wiring (optional driver hooks, legacy
        // defaults when the driver does not provide them).
        const handles = this.driver?.entityModel?.(e.id) ?? null;
        const ea = this.driver?.entityAngles?.(e.id) ?? null;
        return {
          model: handles?.model ?? 0,
          origin: new Float32Array(e.origin) as Entity['origin'],
          angles: new Float32Array(ea ?? [0, 0, 0]) as Entity['angles'],
          frame: this.driver?.entityFrame?.(e.id) ?? 0,
          skin: handles?.skin ?? 0,
        };
      });
    // Extra world entities (bolts / barrels / explosions): snapshot only
    // carries the player + monsters, so the driver appends the rest here.
    // Feature-detected: drivers without the hook render exactly as before.
    const extras = this.driver?.extraEntities?.() ?? null;
    if (extras) {
      for (const x of extras) {
        renderables.push({
          model: x.model ?? 0,
          origin: new Float32Array(x.origin) as Entity['origin'],
          angles: new Float32Array(x.angles ?? [0, 0, 0]) as Entity['angles'],
          frame: x.frame ?? 0,
          skin: x.skin ?? 0,
        });
      }
    }
    // First-person weapon view model (CL_AddViewWeapon,
    // client/cl_ents.c:1293-1342): anchored AT the eye — origin = vieworg
    // + gunoffset (gun_x/y/z default 0, game/g_main.c), angles = the full
    // view angles + gunangles. No forward push (VIEWMODEL_FORWARD = 0),
    // no yaw-only flattening: the gun rides the view exactly, bottom-right
    // placement coming from the baked v_weap verts. The gunangles term is
    // the RF/gunoffset-lite driver hook (p_view.c SV_CalcGunOffset-lite:
    // 0.2*delta turn-lag ±45 clamp + speed-scaled bob sway; static when
    // still). The breech half behind the eye survives via view-space
    // near-plane Sutherland clipping in the alias backend (r_aclip.c), and
    // Entity.depthHack (RF_DEPTHHACK) keeps the gun ahead of nearby walls.
    // Hidden when fovX > 90, like id.
    const vm = this.driver?.viewModel?.() ?? null;
    if (vm && view.fovX <= 90) {
      const gunDelta = this.driver?.gunAnglesDelta?.() ?? null;
      const gunAngles: [number, number, number] = gunDelta
        ? [angles[0] + gunDelta[0], angles[1] + gunDelta[1], angles[2] + gunDelta[2]]
        : angles;
      renderables.push({
        model: vm.model,
        origin: new Float32Array(eye) as Entity['origin'],
        angles: new Float32Array(gunAngles) as Entity['angles'],
        frame: vm.frame,
        skin: vm.skin,
        depthHack: true,
      });
    }
    this.refresh.beginFrame();
    const stats = this.refresh.renderView(view, this.world, renderables);
    this.refresh.endFrame();
    return stats;
  }

  /** Resize the framebuffer (web shell renderer switcher). */
  resize(width: number, height: number): void {
    const next = createFramebuffer(width, height, this.fb.index !== undefined);
    this.refresh.init(next);
    (this as { fb: Framebuffer }).fb = next;
  }
}
