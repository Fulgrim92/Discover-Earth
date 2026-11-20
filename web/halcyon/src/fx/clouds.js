// fx/clouds.js: hook for the half-resolution volumetric cloud pass (DESIGN section 6 step 3).
// Status: not yet implemented. The composite currently draws an analytic 2D cloud layer (sky.wgsl cloudLayer)
// and the Stone Forest cloud sea as a slab (composite.wgsl cloudSea), both driven by the realm fields C0..C2.
// This module owns the half-res target the composite already samples (binding cloudT), so a ray-marched
// Perlin-Worley pass can drop in here: write rgb = in-scattered light, a = transmittance, then switch the
// composite from cloudLayer() to the texture (depth-aware upsample).
import { tex } from '../gpu.js';

export const clouds = { view: null, enabled: false };

export function init(ctx) {}

export function bind(ctx, tg) {
  const w = Math.max(1, tg.w >> 1), h = Math.max(1, tg.h >> 1);
  clouds.view = tex(w, h, 'rgba16float', GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING, { label: 'clouds' }).createView();
  return clouds.view;
}

export function draw(ctx, enc, view) { /* volumetric pass slot */ }
