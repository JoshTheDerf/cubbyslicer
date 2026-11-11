/**
 * Order independent transparency for translucent filaments: Orca 2.5's libvgcode
 * `ViewerImpl::render_translucent_segments` (weighted blended OIT, McGuire and Bavoil 2013, with the
 * nearest translucent surface kept apart), on WebGL2:
 *   1. the opaque scene's depth (Orca copies the canvas depth with glCopyTexSubImage2D; WebGL can't
 *      read the default framebuffer's depth, so the opaque scene is drawn a second time, depth only);
 *   2. the nearest translucent surface's depth (Orca: an R32F target under GL_MIN; here a depth
 *      buffer, which needs no float blending);
 *   3. that surface's colour, and the weighted sum and coverage of the others (RGBA16F, R16F, RGBA16F);
 *   4. a full-screen composite over the scene.
 * Only built while a shown filament is translucent; without renderable half-float colour targets
 * (EXT_color_buffer_half_float / EXT_color_buffer_float) the caller keeps the plain blended pass,
 * which is what Orca's OpenGL ES build draws.
 */
import * as THREE from 'three';
import { OIT_COMPOSITE_FRAG, OIT_COMPOSITE_VERT } from './shaders';

export class OitTargets {
  readonly opaque: THREE.WebGLRenderTarget;
  readonly front: THREE.WebGLRenderTarget;
  readonly accum: THREE.WebGLRenderTarget;
  readonly composite = new THREE.Scene();
  readonly compositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.ShaderMaterial;
  /** Framebuffer completeness, checked on first use: null = not yet. */
  private ok: boolean | null = null;

  /** Null when the context can't render to half-float colour targets. */
  static create(r: THREE.WebGLRenderer): OitTargets | null {
    const ext = r.extensions;
    if (!ext.has('EXT_color_buffer_float') && !ext.has('EXT_color_buffer_half_float')) return null;
    return new OitTargets();
  }

  private constructor() {
    const depthTarget = () => new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType, depthBuffer: true, stencilBuffer: false,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
    });
    this.opaque = depthTarget();
    this.front = depthTarget();
    this.accum = new THREE.WebGLRenderTarget(1, 1, { count: 3, type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false });
    this.accum.textures[1].format = THREE.RedFormat;
    for (const t of [...this.accum.textures, this.opaque.texture, this.front.texture]) { t.minFilter = THREE.NearestFilter; t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; }
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: OIT_COMPOSITE_VERT,
      fragmentShader: OIT_COMPOSITE_FRAG,
      uniforms: { uAccum: { value: this.accum.textures[0] }, uReveal: { value: this.accum.textures[1] }, uFront: { value: this.accum.textures[2] } },
      // premultiplied, over the scene
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      depthTest: false, depthWrite: false, transparent: true,
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const tri = new THREE.Mesh(g, this.material);
    tri.frustumCulled = false;
    this.composite.add(tri);
  }

  /**
   * Size the targets to the drawing buffer; false when the context can't render to them (checked
   * once, on first use: the caller then keeps the blended pass).
   */
  ready(r: THREE.WebGLRenderer, w: number, h: number): boolean {
    if (this.accum.width !== w || this.accum.height !== h) for (const t of [this.opaque, this.front, this.accum]) t.setSize(w, h);
    if (this.ok === null) {
      const gl = r.getContext(), prev = r.getRenderTarget();
      this.ok = [this.opaque, this.front, this.accum].every((t) => { r.setRenderTarget(t); return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE; });
      r.setRenderTarget(prev);
    }
    return this.ok;
  }

  dispose(): void {
    for (const t of [this.opaque, this.front, this.accum]) { t.depthTexture?.dispose(); t.dispose(); }
    this.material.dispose();
    (this.composite.children[0] as THREE.Mesh).geometry.dispose();
  }
}
