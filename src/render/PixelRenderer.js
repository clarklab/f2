import * as THREE from 'three';
import { VIRT_W, VIRT_H } from '../core/Display.js';

/**
 * PixelRenderer — the whole retro look, and most of the performance story.
 *
 * The scene is rendered into a render target of roughly 270x520. That is ~140k
 * pixels; a 1080x2400 phone screen is 2.6 million. Shading ~5% of the pixels a
 * native resolution renderer would is what buys a locked 60 fps with headroom
 * to spare, and it is also exactly what makes the image read as pixel art
 * rather than a smooth 3D scene with a filter over it.
 *
 * HOW THE FRAME REACHES THE SCREEN, and why it is unusual: the WebGL canvas is
 * never in the document at all. It renders offscreen at internal resolution,
 * and every frame is copied with drawImage() into a plain 2D canvas, which is
 * what the page actually shows, upscaled by CSS with nearest-neighbour
 * filtering.
 *
 * That indirection exists because of a real device. On at least one
 * Pixel-class phone, Chrome composites a document WebGL canvas into only the
 * bottom ~60% of its own element, leaving a black band across the top — with
 * the element rect, the drawing buffer size and the GL viewport all reporting
 * correct values, and a 2D canvas under identical CSS compositing perfectly.
 * It survived every indirect fix: matching the buffer to the CSS box 1:1,
 * removing `desynchronized`, removing `image-rendering` from the WebGL canvas,
 * halving the buffer, and hiding the overlay canvas above it. The one
 * presentation path that provably works everywhere we have looked is the 2D
 * canvas raster path — so that is the only path we use. WebGL still does all
 * the rendering; it just never talks to the compositor.
 *
 * The copy is cheap: it is internal-resolution to internal-resolution, 1:1,
 * ~140k pixels, and browsers keep it on the GPU. The CSS upscale on a 2D
 * canvas is the same mechanism the UI overlay has used from the start.
 *
 * COLOUR SPACE — the subtle part. `renderer.outputColorSpace` is only applied
 * when drawing to the default framebuffer; when the destination is a render
 * target, three.js writes in the *working* space, which is Linear-sRGB
 * (WebGLRenderer.js resolves this at its `_currentRenderTarget === null`
 * check). So the target holds linear values. The blit shader therefore has to
 * apply the sRGB transfer curve itself *before* quantising. Quantising linear
 * values instead would crowd all the banding into the shadows and leave the
 * highlights smooth — the opposite of how a real 15-bit framebuffer behaves.
 */

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const QUAD_FRAG = /* glsl */ `
precision mediump float;

uniform sampler2D tDiffuse;
uniform float uLevels;      // quantisation steps per channel
uniform float uDither;      // 0 = hard banding, 1 = full ordered dither
uniform float uSaturation;
uniform float uFlash;       // white/colour flash for impacts and boosts
uniform vec3  uFlashColor;
uniform float uFade;        // 0 = normal, 1 = black, for scene transitions
uniform vec2  uTexSize;     // source resolution, for the dither lattice
varying vec2 vUv;

// Analytic Bayer. Bayer2 evaluates to [[0,2],[3,1]]/4 and the recursion builds
// the 4x4 and 8x8 matrices from it — no arrays, no texture, no branching, and
// it compiles down to a handful of instructions.
float Bayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
#define Bayer4(a) (Bayer2(0.5 * (a)) * 0.25 + Bayer2(a))
#define Bayer8(a) (Bayer4(0.5 * (a)) * 0.25 + Bayer2(a))

// Matches three.js's own sRGB OETF exactly, so colours authored as hex survive
// the linear round-trip and come back out as the value that was typed.
vec3 linearToSRGB(vec3 c) {
  return mix(
    pow(c, vec3(0.41666)) * 1.055 - vec3(0.055),
    c * 12.92,
    vec3(lessThanEqual(c, vec3(0.0031308)))
  );
}

void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;

  c = linearToSRGB(max(c, vec3(0.0)));

  // Mild saturation push — limited palettes read better when colours are
  // committed rather than muddy.
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, uSaturation);

  c = mix(c, uFlashColor, uFlash);
  c = mix(c, vec3(0.0), uFade);

  // Ordered-dither quantisation. The dither amplitude is exactly one
  // quantisation step, which is what turns a hard band edge into a stipple.
  // The lattice is indexed by the source texel so it stays welded to the
  // chunky pixels no matter what resolution this pass happens to run at.
  float d = (Bayer8(floor(vUv * uTexSize)) - 0.5) * uDither;
  c = floor(clamp(c, 0.0, 1.0) * uLevels + 0.5 + d) / uLevels;

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

export class PixelRenderer {
  /**
   * @param presentCtx     2D context of the on-page canvas the frame is shown
   *                       through. Its backing store is internal resolution and
   *                       is sized by Display, like the UI overlay's.
   * @param width,height   internal resolution — what the scene is shaded at
   */
  constructor(presentCtx, width = VIRT_W, height = VIRT_H) {
    this._w = width;
    this._h = height;
    this.presentCtx = presentCtx;

    // Offscreen on purpose — never appended to the document. See the header:
    // the compositor never sees this canvas, so the one browser path that has
    // mishandled a WebGL canvas cannot be taken.
    this.glCanvas = document.createElement('canvas');

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.glCanvas,
      antialias: false,          // smoothing edges is the opposite of the goal
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      // drawImage() reads the drawing buffer synchronously in the same task as
      // the render, which the spec guarantees to see the frame — the buffer is
      // only cleared at compositing time, and this canvas never composites.
      preserveDrawingBuffer: false,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = false;
    this.renderer.info.autoReset = false;

    this.target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
      type: THREE.UnsignedByteType,
      // Explicitly linear: this is what three.js actually writes here, and the
      // blit shader converts. Marking it sRGB would be a lie that only shows up
      // as washed-out midtones.
      colorSpace: THREE.LinearSRGBColorSpace,
      samples: 0,
    });

    this.quadMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.target.texture },
        uLevels: { value: 31.0 },      // 5 bits/channel, like a 15-bit console
        uDither: { value: 1.0 },
        uSaturation: { value: 1.1 },
        uFlash: { value: 0.0 },
        uFlashColor: { value: new THREE.Color(1, 1, 1) },
        uFade: { value: 0.0 },
        uTexSize: { value: new THREE.Vector2(width, height) },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: QUAD_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    // A single oversized triangle rather than a quad: one fewer vertex, no
    // diagonal seam, and the GPU clips the overhang for free.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -1, -1, 0, 3, -1, 0, -1, 3, 0,
    ]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 0, 2, 0, 0, 2,
    ]), 2));
    this.quad = new THREE.Mesh(geo, this.quadMaterial);
    this.quad.frustumCulled = false;
    this.postScene = new THREE.Scene();
    this.postScene.add(this.quad);
    this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.contextLost = false;
    this.glCanvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.onContextLost?.();
    });
    this.glCanvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.onContextRestored?.();
    });
  }

  get width() { return this._w; }
  get height() { return this._h; }

  /**
   * Move to a new internal resolution. The height follows the device aspect
   * (see Display), so this runs on rotation and whenever a mobile URL bar
   * slides in or out. The present canvas's backing store is resized by
   * Display in the same pass.
   */
  resize(w, h) {
    if (w === this._w && h === this._h) return;
    this._w = w;
    this._h = h;
    this.target.setSize(w, h);
    this.renderer.setSize(w, h, false);
    this.quadMaterial.uniforms.uTexSize.value.set(w, h);
  }

  /** Screen flash, 0..1, tinted. Used for impacts, boosts and transitions. */
  setFlash(amount, color) {
    this.quadMaterial.uniforms.uFlash.value = amount;
    if (color !== undefined) this.quadMaterial.uniforms.uFlashColor.value.set(color);
  }

  /** Fade to black, 0..1. */
  setFade(amount) {
    this.quadMaterial.uniforms.uFade.value = amount;
  }

  /** How hard colour is crushed. Fewer levels = chunkier, more retro. */
  setQuantization(levels, dither = 1.0) {
    this.quadMaterial.uniforms.uLevels.value = levels;
    this.quadMaterial.uniforms.uDither.value = dither;
  }

  render(scene, camera) {
    if (this.contextLost) return;
    const r = this.renderer;
    r.info.reset();

    // 1. the scene, at internal resolution
    r.setRenderTarget(this.target);
    r.render(scene, camera);

    // 2. the retro grade, into the offscreen canvas's default framebuffer
    r.setRenderTarget(null);
    r.render(this.postScene, this.postCamera);

    // 3. hand the finished frame to the on-page 2D canvas, 1:1. This is the
    // whole trick: the only canvas the compositor ever sees is a plain 2D one.
    this.presentCtx.drawImage(this.glCanvas, 0, 0);
  }

  /**
   * Everything the black-band investigation needs, read from the live GL
   * context rather than from anything this class believes about itself. If our
   * bookkeeping and the driver ever disagree, this is where it shows.
   */
  probe() {
    const gl = this.renderer.getContext();
    return {
      internal: [this._w, this._h],
      glCanvas: [this.glCanvas.width, this.glCanvas.height],
      present: [this.presentCtx.canvas.width, this.presentCtx.canvas.height],
      drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      glViewport: Array.from(gl.getParameter(gl.VIEWPORT)),
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxViewport: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS)),
      contextLost: this.contextLost,
    };
  }

  get drawCalls() { return this.renderer.info.render.calls; }
  get triangles() { return this.renderer.info.render.triangles; }

  dispose() {
    this.target.dispose();
    this.quadMaterial.dispose();
    this.quad.geometry.dispose();
    this.renderer.dispose();
  }
}
