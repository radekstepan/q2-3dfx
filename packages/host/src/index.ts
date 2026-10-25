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
import type { Snapshot } from '@q2/client';
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
}

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
  serverTime = 0;
  lastCmd: UserCmdT | null = null;
  private serverAcc = 0;
  private lastNow = -1;
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
  }

  /** Server tick via @q2/server when it can, else advance time only. */
  private serverTick(dt: number): void {
    this.serverTime += dt;
  }

  /** Feed an authoritative snapshot (server -> client). */
  ingestSnapshot(snap: Snapshot): void {
    this.predictor.pushSnapshot(snap);
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

    // Fixed-step server ticks at 10Hz.
    this.serverAcc += dt;
    while (this.serverAcc >= SERVER_DT) {
      this.serverAcc -= SERVER_DT;
      this.serverTick(SERVER_DT);
      this.ingestSnapshot(this.offlineSnapshot());
    }

    // Client command from accumulated input.
    const msec = Math.max(1, Math.round(dt * 1000));
    this.lastCmd = buildUserCmd(this.input, msec, {
      sensitivity: getCVarNumber('sensitivity') || 3,
      mYaw: getCVarNumber('m_yaw') || 0.022,
      mPitch: getCVarNumber('m_pitch') || 0.022,
    });
    // Offline prediction: integrate the synthetic player with the cmd.
    if (getCVarNumber('cl_predict') !== 0 && this.lastCmd) {
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
    const entities = this.predictor.renderEntities(this.serverTime, this.localPlayerId);
    const viewOrigin = calcViewOrigin(this.playerOrigin);
    const angles: [number, number, number] = this.lastCmd
      ? [this.lastCmd.angles[0], this.lastCmd.angles[1], this.lastCmd.angles[2]]
      : [0, 0, 0];
    const view: RefDef = {
      origin: new Float32Array(viewOrigin) as RefDef['origin'],
      angles: new Float32Array(angles) as RefDef['angles'],
      fovX: 90,
      time: this.serverTime,
      lightStyles: new Float32Array(256).fill(1),
    };
    const renderables: Entity[] = entities.map((e) => ({
      model: 0,
      origin: new Float32Array(e.origin) as Entity['origin'],
      angles: new Float32Array([0, 0, 0]) as Entity['angles'],
      frame: 0,
      skin: 0,
    }));
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
