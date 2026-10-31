// @q2/client — CL_: prediction, interpolation, view, HUD, console (M6.1).
export {
  extrapolateOrigin,
  lerpOrigin,
  clamp01,
  lerpAngle,
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
  PIC_TRANSPARENT,
  FIELD_DIGIT_W,
  FIELD_DIGIT_H,
  FIELD_MAX_WIDTH,
  ICON_SIZE,
  makeConcharsFont,
  loadConcharsFont,
  setConcharsFont,
  getConcharsFont,
  drawChar,
  drawString,
  stringWidth,
  fillRect,
  drawPic,
  formatField,
  drawField,
} from './hud.js';
export type { ConcharsFont, ConcharsImage, BlitSurface, IndexedPic, DigitPics } from './hud.js';
export {
  CS_STATUSBAR,
  STAT_HEALTH_ICON,
  STAT_HEALTH,
  STAT_AMMO_ICON,
  STAT_AMMO,
  STAT_ARMOR_ICON,
  STAT_ARMOR,
  STAT_SELECTED_ICON,
  STAT_PICKUP_ICON,
  STAT_PICKUP_STRING,
  STAT_TIMER_ICON,
  STAT_TIMER,
  STAT_HELPICON,
  STAT_SELECTED_ITEM,
  STAT_LAYOUTS,
  STAT_FRAGS,
  STAT_FLASHES,
  STAT_CHASE,
  STAT_SPECTATOR,
  FLASH_HEALTH,
  FLASH_ARMOR,
  FLASH_AMMO,
  MAX_IMAGES,
  MAX_CLIENTS,
  FLASH_FIELD_PIC,
  tokenizeLayout,
  parseStatusbar,
  layoutX,
  layoutY,
  executeStatusbar,
  Configstrings,
} from './statusbar.js';
export type { StatusOp, LayoutXMode, LayoutYMode, DigitStyle, StatusbarState, StatusDrawCmd, StatusClientInfo } from './statusbar.js';
export { HELP_PIC, HELP_W, HELP_H, skillName, pad3, buildHelpLayout } from './help.js';
export type { HelpFacts } from './help.js';
export {
  INTERMISSION_MIN_TIME,
  VICTORY_PIC,
  VICTORY_W,
  VICTORY_H,
  showsIntermissionScoreboard,
  sortScoreboard,
  scoreCell,
  scoreTag,
  buildScoreboardLayout,
  centerPrintLines,
  centerPrintPlacement,
  DISPLAY_ITEMS,
  INVENTORY_PIC,
  INVENTORY_W,
  INVENTORY_H,
  INVENTORY_HEADER_1,
  INVENTORY_HEADER_2,
  formatInventoryRow,
  layoutInventory,
} from './screens.js';
export type { ScoreEntry, CenterLine, InventoryItem, InventoryRow, InventoryLayout } from './screens.js';
export { CONSOLE_MAX_LINES, GameConsole } from './console.js';

/** View height above the player origin (Q2 uses 22 standing). */
export const VIEW_HEIGHT = 22;
/** Ducked view height (pmove sets viewheight -2 when PMF_DUCKED, i.e. feet+22). */
export const VIEW_HEIGHT_DUCKED = -2;

/** Camera origin for a predicted player origin. Pass ducked=true when PMF_DUCKED. */
export function calcViewOrigin(playerOrigin: [number, number, number], ducked = false): [number, number, number] {
  return [playerOrigin[0], playerOrigin[1], playerOrigin[2] + (ducked ? VIEW_HEIGHT_DUCKED : VIEW_HEIGHT)];
}
