import * as THREE from 'three';
import { VIRT_W, VIRT_H } from '../core/Display.js';

/**
 * PixelRenderer — the whole retro look, and most of the performance story.
 *
 * The scene is rendered into a 270x480 render target. That is 129,600 pixels;
 * a 1080x2400 phone screen is 2.6 million. Shading ~5% of the pixels a native
 * resolution renderer would is what buys a locked 60 fps with headroom to
 * spare, and it is also exactly what makes the image read as pixel art rather
 * than a smooth 3D scene with a filter over it.
 *
 * The target is then blitted 1:1 to a canvas whose backing store is also
 * 270x480, and the browser scales *that* up with nearest-neighbour filtering
 * via CSS. No expensive upscale pass, and every source pixel lands on an exact
 * square block of device pixels.
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
  float d = (Bayer8(gl_FragCoord.xy) - 0.5) * uDither;
  c = floor(clamp(c, 0.0, 1.0) * uLevels + 0.5 + d) / uLevels;

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

export class PixelRenderer {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // only affects the default framebuffer anyway,
                                 // and smoothing edges is the opposite of the goal
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      // Lets the compositor show our frame without waiting in its queue. It is
      // a hint; when honoured it removes a frame of input-to-photon latency.
      desynchronized: true,
    });
    this.renderer.setPixelRatio(1);        // never render above the internal res
    this.renderer.setSize(VIRT_W, VIRT_H, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = false;
    this.renderer.info.autoReset = false;

    this.target = new THREE.WebGLRenderTarget(VIRT_W, VIRT_H, {
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

  get width() { return VIRT_W; }
  get height() { return VIRT_H; }

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
    r.setRenderTarget(this.target);
    r.render(scene, camera);
    r.setRenderTarget(null);
    r.render(this.postScene, this.postCamera);
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
