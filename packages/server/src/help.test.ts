// RELEASE-6 server lane: game.helpchanged producer (no HUD code).
//
// Ground truth: game/g_target.c Use_Target_Help (message latch +
// game.helpchanged++), SP_target_help (SP-only, frees message-less edicts),
// game/p_view.c G_SetClientSound (latch + pc_up beep x3 every 64th frame),
// game/p_hud.c G_SetStats (i_help flash while unacked and framenum&8) and
// Cmd_Help_f (toggle/ack). The server owns ONLY the game-side sequence +
// message strings; the per-client ack (pers.game_helpchanged /
// pers.helpchanged / showhelp) lives in the driver (SP, in-process).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { spawnEdict } from '@q2/game';
import { PakFile } from '@q2/filesystem';
import { loadBsp } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import {
  SV_Init,
  SV_LinkEdict,
  SV_SpawnEntities,
  fireTargets,
  helpBeepDue,
  helpIconVisible,
} from './index.js';

const HELP_LOGIC = `
{
"classname" "worldspawn"
}
{
"classname" "trigger_once"
"targetname" "intro"
"target" "helps"
}
{
"classname" "target_help"
"targetname" "helps"
"message" "Find the exit."
}
{
"classname" "target_help"
"targetname" "helps"
"spawnflags" "1"
"message" "Call command."
}
{
"classname" "target_help"
"targetname" "dangling"
}
`;

describe('help notification producer (RELEASE-6 server lane)', () => {
  it('starts unacked with empty messages', () => {
    const st = SV_Init();
    expect(st.helpChangedSeq).toBe(0);
    expect(st.helpMessage1).toBe('');
    expect(st.helpMessage2).toBe('');
  });

  it('routes spawnflags to helpmessage1/2 and bumps the seq every firing', () => {
    const st = SV_Init();
    SV_SpawnEntities(st, HELP_LOGIC);
    const trig = st.entities.find((e) => !e.freed && e.classname === 'trigger_once')!;
    fireTargets(st, trig);
    // Both helps share targetname "helps": plain flag -> message2, flag 1
    // -> message1 (entity order), seq bumped once per firing (not single-use).
    expect(st.helpMessage2).toBe('Find the exit.');
    expect(st.helpMessage1).toBe('Call command.');
    expect(st.helpChangedSeq).toBe(2);
    fireTargets(st, trig);
    expect(st.helpChangedSeq).toBe(4);
  });

  it('frees message-less target_help at spawn (C SP_target_help)', () => {
    const st = SV_Init();
    SV_SpawnEntities(st, HELP_LOGIC);
    const dangling = st.entities.filter((e) => e.classname === 'target_help' && e.targetname === 'dangling');
    expect(dangling).toHaveLength(1);
    expect(dangling[0]!.freed).toBe(true);
    const live = st.entities.filter((e) => e.classname === 'target_help' && !e.freed);
    expect(live).toHaveLength(2);
  });

  it('fires a synthetic target_help by targetname (no base1 needed)', () => {
    const st = SV_Init();
    const help = spawnEdict({ classname: 'target_help', targetname: 'h', message: 'Hi.' });
    SV_LinkEdict(st, help);
    const user = spawnEdict({ classname: 'trigger_once', target: 'h' });
    SV_LinkEdict(st, user);
    fireTargets(st, user);
    expect(st.helpChangedSeq).toBe(1);
    expect(st.helpMessage2).toBe('Hi.');
    expect(st.helpMessage1).toBe('');
  });

  it('helpIconVisible matches G_SetStats: unacked + (framenum&8)', () => {
    expect(helpIconVisible(0, 8)).toBe(false);
    expect(helpIconVisible(0, 0)).toBe(false);
    for (let f = 0; f < 8; f++) expect(helpIconVisible(1, f)).toBe(false);
    for (let f = 8; f < 16; f++) expect(helpIconVisible(1, f)).toBe(true);
    for (let f = 16; f < 24; f++) expect(helpIconVisible(2, f)).toBe(false);
    expect(helpIconVisible(4, 40)).toBe(true);
  });

  it('helpBeepDue matches G_SetClientSound: counter 1..3 every 64th frame', () => {
    expect(helpBeepDue(0, 0)).toBe(false);
    expect(helpBeepDue(1, 0)).toBe(true);
    expect(helpBeepDue(3, 64)).toBe(true);
    expect(helpBeepDue(1, 1)).toBe(false);
    expect(helpBeepDue(2, 63)).toBe(false);
    expect(helpBeepDue(2, 128)).toBe(true);
    // Counter exceeds 3 -> stops (the third beep increments it to 4).
    expect(helpBeepDue(4, 192)).toBe(false);
  });
});

const Q2_PAK = process.env.Q2_PAK;

describe.runIf(!!Q2_PAK)('help producer on real base1 (Q2_PAK)', () => {
  it('base1 ships two live target_help edicts; firing t70 latches both messages', () => {
    const bytes = readFileSync(Q2_PAK as string);
    const buf = new ArrayBuffer(bytes.length);
    new Uint8Array(buf).set(bytes);
    const pak = new PakFile(buf);
    const map = loadBsp(pak.readFile('maps/base1.bsp')) as BspMap;
    const st = SV_Init();
    SV_SpawnEntities(st, map.entities);
    const helps = st.entities.filter((e) => !e.freed && e.classname === 'target_help');
    expect(helps).toHaveLength(2);
    expect(st.helpChangedSeq).toBe(0);
    // The *16 trigger_once targets t70 (relay + speaker + both helps).
    const user = spawnEdict({ classname: 'trigger_once', target: 't70' });
    SV_LinkEdict(st, user);
    fireTargets(st, user);
    expect(st.helpChangedSeq).toBe(2);
    expect(st.helpMessage2).toBe('Locate base installation\nelevator.');
    expect(st.helpMessage1).toBe('Establish communication\nlink to command ship.');
  });
});
