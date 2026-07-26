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
 * THE UPSCALE happens here, in the blit, not in CSS. That is deliberate and it
 * cost a bug to learn. Handing the browser a 271x525 WebGL drawing buffer and
 * asking CSS to stretch it ~4x is unusual enough that Chrome for Android gets
 * it wrong: it promotes the canvas to a hardware overlay and paints the scene
 * into a fraction of the element, leaving a black band across the top of the
 * screen. The 2D UI canvas, with identical CSS, composites correctly — which is
 * what isolates WebGL-plus-tiny-buffer as the variable.
 *
 * So the canvas's drawing buffer now matches its CSS box 1:1 in device pixels
 * and we do the nearest-neighbour magnification ourselves, in three passes:
 *
 *   1. scene  -> target       at internal resolution  (~140k px, all the work)
 *   2. grade  -> gradeTarget  at internal resolution  (~140k px)
 *   3. copy   -> canvas       at device resolution    (~2.6M px, one fetch)
 *
 * Splitting 2 from 3 is the point. Grading during magnification would run the
 * sRGB curve, the saturation push, the quantiser and the dither at 2.6M pixels
 * instead of 140k, for an image that has at most 140k distinct values in it.
 * As it stands the only full-resolution work is a single NEAREST fetch where
 * every 4x4 block of output pixels shares one texel — pure bandwidth, and about
 * as cache-friendly as sampling gets.
 *
 * The dither also has to key off the *source* texel rather than gl_FragCoord —
 * see the fragment shader.
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
  //
  // The lattice is indexed by the *source* texel, not by gl_FragCoord. This
  // pass runs at device resolution, so a screen-space lattice would put a full
  // 8x8 Bayer cell inside every single source pixel — the stipple would shrink
  // below the eye's resolving power and the whole 15-bit-framebuffer illusion
  // would collapse into smooth gradients. Keyed to the texel, one dither cell
  // spans 8 chunky pixels exactly as it did when the blit was 1:1.
  float d = (Bayer8(floor(vUv * uTexSize)) - 0.5) * uDither;
  c = floor(clamp(c, 0.0, 1.0) * uLevels + 0.5 + d) / uLevels;

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

// The full-resolution pass. One texture fetch, nothing else. The grade has
// already happened at low resolution, so magnification is pure bandwidth — and
// a NEAREST fetch where 4x4 output pixels share one texel is about as friendly
// as a texture cache ever gets.
const COPY_FRAG = /* glsl */ `
precision mediump float;
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, 1.0);
}
`;

export class PixelRenderer {
  /**
   * @param canvas         the scene canvas; this class owns its drawing buffer
   * @param width,height   internal resolution — what the scene is shaded at
   * @param outW,outH      output resolution — the canvas box in device pixels
   */
  constructor(canvas, width = VIRT_W, height = VIRT_H, outW = width, outH = height) {
    this._w = width;
    this._h = height;
    this._outW = outW;
    this._outH = outH;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // only affects the default framebuffer anyway,
                                 // and smoothing edges is the opposite of the goal
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      // NOT `desynchronized`. It is only a latency hint, and on Chrome for
      // Android it promotes the canvas to a hardware overlay whose bounds are
      // computed from the drawing buffer rather than from the CSS box. With a
      // 270-wide buffer stretched across a 1080-wide phone, the overlay lands
      // at the wrong size and the 3D scene is drawn into a fraction of its
      // element while the UI canvas above it is placed correctly — a black band
      // across the top of the screen that no amount of layout work removes.
      // One frame of latency is not worth that.
    });
    // The renderer's "size" is the *output* size — the default framebuffer it
    // blits to. The scene never touches it; the scene is sized by the render
    // target below. `false` leaves the canvas CSS alone: the stylesheet
    // stretches the element to the stage and must keep doing so.
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(outW, outH, false);
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

    // Holds the graded, quantised, dithered image at internal resolution. The
    // grade runs here rather than in the magnification pass so its cost stays
    // proportional to ~140k pixels instead of the device's ~2.6M. Already
    // sRGB-encoded by the grade shader, so it is tagged linear to stop three.js
    // applying the transfer curve a second time on sample.
    this.gradeTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
      type: THREE.UnsignedByteType,
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

    this.copyMaterial = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: this.gradeTarget.texture } },
      vertexShader: QUAD_VERT,
      fragmentShader: COPY_FRAG,
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
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.onContextLost?.();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.onContextRestored?.();
    });
  }

  get width() { return this._w; }
  get height() { return this._h; }

  /**
   * Move to a new internal resolution and/or output size. The internal height
   * follows the device aspect (see Display), so this runs on rotation and
   * whenever a mobile URL bar slides in or out.
   */
  resize(w, h, outW = w, outH = h) {
    if (w !== this._w || h !== this._h) {
      this._w = w;
      this._h = h;
      this.target.setSize(w, h);
      this.gradeTarget.setSize(w, h);
      this.quadMaterial.uniforms.uTexSize.value.set(w, h);
    }
    if (outW !== this._outW || outH !== this._outH) {
      this._outW = outW;
      this._outH = outH;
      this.renderer.setSize(outW, outH, false);
    }
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

    // 2. the retro grade, still at internal resolution
    this.quad.material = this.quadMaterial;
    r.setRenderTarget(this.gradeTarget);
    r.render(this.postScene, this.postCamera);

    // 3. magnify to the canvas at device resolution
    this.quad.material = this.copyMaterial;
    r.setRenderTarget(null);
    r.render(this.postScene, this.postCamera);
  }

  /**
   * Everything the black-band investigation needs, read from the live GL
   * context rather than from anything this class believes about itself. If our
   * bookkeeping and the driver ever disagree, this is where it shows.
   */
  probe() {
    const gl = this.renderer.getContext();
    const cv = this.renderer.domElement;
    return {
      internal: [this._w, this._h],
      requestedOut: [this._outW, this._outH],
      canvasAttr: [cv.width, cv.height],
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
    this.gradeTarget.dispose();
    this.copyMaterial.dispose();
    this.quadMaterial.dispose();
    this.quad.geometry.dispose();
    this.renderer.dispose();
  }
}
