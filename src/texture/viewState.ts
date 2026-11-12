/**
 * The Texture Displacement tool's view row (desktop apply_view_mode /
 * m_wireframe_overlay): Normal shows the real geometry the bake will make,
 * Fast shades the active layer's relief on without building it; Wireframe
 * overlays the triangles of whichever surface is shown. Shared by the panel
 * and the MCP bridge. Reset when the tool closes, as desktop's on_shutdown.
 */
import { reactive } from 'vue';

export type TextureView = 'normal' | 'fast';

export const textureUi = reactive({
  view: 'normal' as TextureView,
  wireframe: false,
  /** Desktop's Adjust placement mode (dragging the handle instead of painting). */
  placing: false,
});

export function resetTextureUi(): void {
  textureUi.view = 'normal';
  textureUi.wireframe = false;
  textureUi.placing = false;
}
