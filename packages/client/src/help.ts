// @q2/client/help — F1 help-computer layout (RELEASE-6).
//
// Ground truth: `game/p_hud.c: HelpComputer` sends a `svc_layout` string the
// client draws with the same `xv`/`yv`/`picn`/`string2`/`cstring2` ops as the
// statusbar. The 256x192 `pics/help.pcx` background, the `xv 32 yv 8 picn
// help` origin and the skill / level-name / help-text / kills-goals-secrets
// rows below are the original asset-based F1 screen; the readable conchars
// fallback stays for the asset-free devroom.

/** Background pic of the F1 help computer (256x192). */
export const HELP_PIC = 'help';
export const HELP_W = 256;
export const HELP_H = 192;

/** Skill label from the `skill` cvar (`game/p_hud.c: HelpComputer`). */
export function skillName(skill: number): string {
  if (skill === 0) return 'easy';
  if (skill === 1) return 'medium';
  if (skill === 2) return 'hard';
  return 'hard+';
}

/** Facts rendered on the F1 help computer.
 *
 * The kills/goals/secrets pairs are LIVE counters (`level.killed_monsters`,
 * `level.found_goals`, `level.found_secrets` over their totals) — the same
 * values `HelpComputer` (`game/p_hud.c`) formats into the layout string every
 * time F1 opens. Callers must pass the live counters here, NOT the
 * `SV_FinishLevel` frozen finish snapshots (which exist only for the
 * completion/intermission presentation).
 */
export interface HelpFacts {
  readonly skill: number;
  readonly levelName: string;
  readonly help1: string;
  readonly help2: string;
  readonly kills: readonly [killed: number, total: number];
  readonly goals: readonly [found: number, total: number];
  readonly secrets: readonly [found: number, total: number];
}

/** Right-align in a 3-wide field (`%3i`). */
export function pad3(value: number): string {
  return `${Math.trunc(value)}`.padStart(3, ' ');
}

/**
 * Build the exact F1 layout string id sends (`HelpComputer`): help-pic
 * background, skill label, centered level name and help texts, and the
 * kills/goals/secrets progress rows. Parseable by `parseStatusbar`.
 *
 * Format pins id's `Com_sprintf`: kills use `%3i/%3i` (see `pad3`), goals and
 * secrets use bare `%i/%i` (no padding). The counters are the LIVE values
 * from `HelpFacts` — see its docs.
 */
export function buildHelpLayout(f: HelpFacts): string {
  return (
    'xv 32 yv 8 picn help ' +
    `xv 202 yv 12 string2 "${skillName(f.skill)}" ` +
    `xv 0 yv 24 cstring2 "${f.levelName}" ` +
    `xv 0 yv 54 cstring2 "${f.help1}" ` +
    `xv 0 yv 110 cstring2 "${f.help2}" ` +
    'xv 50 yv 164 string2 " kills     goals    secrets" ' +
    `xv 50 yv 172 string2 "${pad3(f.kills[0])}/${pad3(f.kills[1])}     ` +
    `${f.goals[0]}/${f.goals[1]}       ${f.secrets[0]}/${f.secrets[1]}" `
  );
}

// ---------------------------------------------------------------------------
// Help-icon flash (`game/p_hud.c: G_SetStats` STAT_HELPICON).
// ---------------------------------------------------------------------------

/** Pic drawn while the F1 help notification flashes (`i_help`). */
export const HELP_ICON_PIC = 'i_help';

/**
 * Inputs for `helpIconFor` — the client-visible slice of `G_SetStats` state.
 * Pure data; the integrator resolves the returned pic name to an image.
 */
export interface HelpIconArgs {
  /**
   * `pers.helpchanged` (nonzero = unacknowledged help change pending).
   * Cleared when the player opens help; while nonzero the icon flashes.
   */
  readonly helpChanged: number;
  /**
   * Server frame number (`level.framenum`, 10 Hz). Callers holding
   * `level.time` seconds pass `Math.floor(serverTime * 10)`.
   */
  readonly frame: number;
  /** `pers.hand == CENTER_HANDED`. */
  readonly centerHanded: boolean;
  /** `ps.fov`. */
  readonly fov: number;
  /**
   * Current weapon icon pic name (`pers.weapon->icon`), or null/undefined/
   * '' when unarmed (`pers.weapon == null`).
   */
  readonly weaponIcon: string | null | undefined;
}

/**
 * Pure `STAT_HELPICON` semantics from `G_SetStats`:
 *
 * ```
 * if (helpchanged && (framenum & 8)) STAT_HELPICON = imageindex("i_help");
 * else if ((centerHanded || fov > 91) && weapon) STAT_HELPICON = imageindex(weapon->icon);
 * else STAT_HELPICON = 0;
 * ```
 *
 * Returns the pic name to draw, or null for 0 (nothing drawn). Never throws:
 * non-integer frames are truncated, `NaN` behaves as 0, and a missing/empty
 * weapon icon falls through to null. No rendering, no state.
 */
export function helpIconFor(args: HelpIconArgs): string | null {
  if (args.helpChanged !== 0 && (Math.trunc(args.frame) & 8) !== 0) {
    return HELP_ICON_PIC;
  }
  if ((args.centerHanded || args.fov > 91) && args.weaponIcon) {
    return args.weaponIcon;
  }
  return null;
}
