// @q2/client — CL_: prediction, interpolation, view, HUD, console (M6.1).
export {
  extrapolateOrigin,
  lerpOrigin,
  clamp01,
  interpFraction,
  renderTimeFor,
  CL_Interpolate,
  CL_Predict,
  CL_PredictPmove,
  Predictor,
} from './prediction.js';
export type { Origin3, EntityState, Snapshot, InterpolatedEntity, PredictCmd } from './prediction.js';
export {
  GLYPH_W,
  GLYPH_H,
  CONCHARS_COUNT,
  CONCHARS_PIC_SIZE,
  CONCHARS_GRID,
  CONCHARS_TRANSPARENT,
  makeConcharsFont,
  loadConcharsFont,
  setConcharsFont,
  getConcharsFont,
  drawChar,
  drawString,
  stringWidth,
  fillRect,
} from './hud.js';
export type { ConcharsFont, ConcharsImage, BlitSurface } from './hud.js';
export { CS_STATUSBAR, tokenizeLayout, parseStatusbar, Configstrings } from './statusbar.js';
export type { StatusOp } from './statusbar.js';
export { CONSOLE_MAX_LINES, GameConsole } from './console.js';

/** View height above the player origin (Q2 uses 22 standing). */
export const VIEW_HEIGHT = 22;

/** Camera origin for a predicted player origin. */
export function calcViewOrigin(playerOrigin: [number, number, number]): [number, number, number] {
  return [playerOrigin[0], playerOrigin[1], playerOrigin[2] + VIEW_HEIGHT];
}
