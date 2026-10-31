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

/** Facts rendered on the F1 help computer. */
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
