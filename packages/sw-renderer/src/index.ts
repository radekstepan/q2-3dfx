// @q2/sw-renderer — ref_soft port. M3.1..M3.4 own this. See BRAIN.md §7.1.
import { Com_Error } from '@q2/config';
import type { Refresh, Framebuffer } from '@q2/renderer-api';
export interface Span { y: number; x0: number; x1: number; z0: number; dz: number; u0: number; v0: number; du: number; dv: number; light: number; dlight: number }
export interface SpanList { spans: Span[] }
export interface Texture { width: number; height: number; texels: Uint8Array }
export interface LightBlock { width: number; height: number; values: Uint8Array }
export interface RasterBackend { drawSpans(list: SpanList, tex: Texture, light: LightBlock): void }
export function drawSpans16(_fb: Framebuffer, _list: SpanList, _tex: Texture, _light: LightBlock, _colormap: Uint8Array): void { Com_Error('fatal', 'not implemented: drawSpans16'); }
export class SoftwareRenderer implements Refresh {
  init(_fb: Framebuffer): void { Com_Error('fatal', 'not implemented'); }
  beginFrame(): void { Com_Error('fatal', 'not implemented'); }
  renderView(): never { Com_Error('fatal', 'not implemented'); }
  endFrame(): void { Com_Error('fatal', 'not implemented'); }
  setPalette(): void { Com_Error('fatal', 'not implemented'); }
  registerModel(): never { Com_Error('fatal', 'not implemented'); }
  registerSkin(): never { Com_Error('fatal', 'not implemented'); }
}
