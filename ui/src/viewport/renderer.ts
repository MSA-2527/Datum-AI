/**
 * WebGL2 renderer for solids.
 *
 * Written directly against WebGL rather than pulling in a scene-graph library, because what
 * a CAD viewport needs is narrow and specific, and almost none of what a general 3D engine
 * provides is any of it. There are no materials, no lights to manage, no animation and no
 * scene graph — one solid, one set of edges, one camera. What there *is* instead is
 * per-face identity for picking and highlighting, which general engines do not provide and
 * which is the whole point here.
 *
 * Three passes:
 *   1. Shaded triangles, with each face's own colour so selection and hover read instantly.
 *   2. Edges as lines, drawn with a depth bias so they sit on the surface rather than
 *      fighting it.
 *   3. An off-screen id buffer, rendered only when the pointer moves, so picking is a
 *      single-pixel read rather than a ray cast against every triangle.
 */

import type { Mat4 } from '../kernel/math/vec';
import { shadingMesh, type Mesh } from '../kernel/topo/mesh';

// ── shaders ──────────────────────────────────────────────────────────────────

const SOLID_VS = `#version 300 es
precision highp float;

in vec3 aPosition;
in vec3 aNormal;
in float aFaceId;

uniform mat4 uView;
uniform mat4 uProjection;

out vec3 vNormal;
out vec3 vViewPos;
out vec3 vWorldPos;
flat out float vFaceId;

void main() {
  vec4 viewPos = uView * vec4(aPosition, 1.0);
  vViewPos = viewPos.xyz;
  // Kept in world space, because a section plane is a fact about the part and not about where
  // the camera happens to be. Clipping in view space would slice a different half of the model
  // every time it was orbited.
  vWorldPos = aPosition;
  // Normals are transformed by the view rotation only; the model matrix is identity here
  // because geometry is already in world coordinates.
  vNormal = mat3(uView) * aNormal;
  vFaceId = aFaceId;
  gl_Position = uProjection * viewPos;
}`;

const SOLID_FS = `#version 300 es
precision highp float;

in vec3 vNormal;
in vec3 vWorldPos;
in vec3 vViewPos;
flat in float vFaceId;

uniform vec3 uBaseColour;
uniform vec3 uSelectedColour;
uniform vec3 uHoverColour;
uniform vec3 uPickedColour;
uniform float uHoverFace;
uniform float uSelectedFeatureLo;
uniform float uSelectedFeatureHi;

// Section plane, as a normal and an offset along it. Everything on the positive side is
// discarded, so the cut face is whatever was behind it.
uniform vec3 uSectionNormal;
uniform float uSectionOffset;
uniform bool uSectionOn;

// Picked faces, as a bitmap in a texture.
//
// A uniform array would cap the selection at whatever length was declared, and a loop over
// it costs a comparison per face per fragment. One texel lookup is constant time and has no
// limit, which matters because "select this whole feature" can mean hundreds of faces.
uniform sampler2D uPicked;
uniform float uPickedWidth;
uniform bool uHasPicked;

// Each face's own colour, looked up rather than passed per vertex.
//
// A vertex attribute would mean re-uploading the whole position buffer to recolour one
// component; a uniform array would cap the model at whatever length was declared. A texture
// indexed by face id is one upload of a few kilobytes, has no limit, and is the same trick
// the picked-face bitmap above already uses.
uniform sampler2D uFaceColour;
uniform float uFaceColourWidth;
uniform bool uHasFaceColour;

out vec4 outColour;

void main() {
  if (uSectionOn && dot(vWorldPos, uSectionNormal) > uSectionOffset) discard;

  // Two-sided lighting: a face seen from behind — through a bore, or in a section — must
  // still be lit, or the inside of every hole is a black void.
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;

  // Headlight plus a fill from below. A single light leaves downward faces pure black and
  // the part unreadable; the fill keeps them legible without washing out the shading that
  // communicates the form.
  vec3 lightDir = normalize(vec3(0.35, 0.45, 1.0));
  float key = max(dot(n, lightDir), 0.0);
  float fill = max(dot(n, normalize(vec3(-0.4, -0.3, -0.6))), 0.0) * 0.28;
  float ambient = 0.34;

  // A faint rim brightens edges facing away, which reads as the silhouette and helps
  // separate the part from the background.
  vec3 viewDir = normalize(-vViewPos);
  float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0) * 0.18;

  vec3 colour = uBaseColour;
  if (uHasFaceColour) {
    float idx = floor(vFaceId + 0.5);
    float w = max(uFaceColourWidth, 1.0);
    if (idx >= 0.0 && idx < w * w) {
      vec2 uv = (vec2(mod(idx, w), floor(idx / w)) + 0.5) / vec2(w, w);
      colour = texture(uFaceColour, uv).rgb;
    }
  }

  bool inSelectedFeature =
    uSelectedFeatureLo >= 0.0 &&
    vFaceId >= uSelectedFeatureLo - 0.5 &&
    vFaceId <= uSelectedFeatureHi + 0.5;

  bool picked = false;
  if (uHasPicked) {
    float idx = floor(vFaceId + 0.5);
    float w = max(uPickedWidth, 1.0);
    // The texture is only as large as the highest picked id, so most of the model's faces
    // fall outside it. Without this bound the row index runs past 1.0, CLAMP_TO_EDGE folds
    // it back onto the last row, and every face beyond the texture inherits whatever that
    // texel holds — which showed up as the entire body highlighting when one face was picked.
    if (idx >= 0.0 && idx < w * w) {
      vec2 uv = (vec2(mod(idx, w), floor(idx / w)) + 0.5) / vec2(w, w);
      picked = texture(uPicked, uv).r > 0.5;
    }
  }

  if (picked) colour = uPickedColour;
  else if (inSelectedFeature) colour = uSelectedColour;
  else if (abs(vFaceId - uHoverFace) < 0.5) colour = uHoverColour;

  vec3 lit = colour * (ambient + key * 0.72 + fill) + vec3(rim);
  outColour = vec4(lit, 1.0);
}`;

const EDGE_VS = `#version 300 es
precision highp float;

in vec3 aPosition;
uniform mat4 uView;
uniform mat4 uProjection;
uniform float uDepthBias;

void main() {
  vec4 viewPos = uView * vec4(aPosition, 1.0);
  // Nudge edges toward the camera so they draw on top of the surface they belong to
  // instead of z-fighting with it, which shows up as edges that flicker and break up as
  // the model is orbited.
  viewPos.z += uDepthBias;
  gl_Position = uProjection * viewPos;
}`;

const EDGE_FS = `#version 300 es
precision highp float;
uniform vec3 uColour;
uniform float uAlpha;
out vec4 outColour;
void main() { outColour = vec4(uColour, uAlpha); }`;

const PICK_VS = `#version 300 es
precision highp float;

in vec3 aPosition;
in float aFaceId;
uniform mat4 uView;
uniform mat4 uProjection;
flat out float vFaceId;

void main() {
  vFaceId = aFaceId;
  gl_Position = uProjection * uView * vec4(aPosition, 1.0);
}`;

const PICK_FS = `#version 300 es
precision highp float;
flat in float vFaceId;
out vec4 outColour;

void main() {
  // Face ids are encoded across three channels, giving 16.7 million distinguishable faces —
  // far past any real part. Packing into one channel would cap it at 255 and silently
  // alias distinct faces onto the same id.
  int id = int(vFaceId) + 1;
  outColour = vec4(
    float(id & 0xFF) / 255.0,
    float((id >> 8) & 0xFF) / 255.0,
    float((id >> 16) & 0xFF) / 255.0,
    1.0
  );
}`;

// ── renderer ─────────────────────────────────────────────────────────────────

export interface RenderOptions {
  view: Mat4;
  projection: Mat4;
  /** Face tags explicitly picked by the user, for scoping an operation to them. */
  pickedFaces: number[];
  /** Face tag under the pointer, or -1. */
  hoverFace: number;
  /** Inclusive face-tag range belonging to the selected feature, or [-1, -1]. */
  selectedFeatureRange: [number, number];
  showEdges: boolean;
  dark: boolean;
  /**
   * Cut the model open along a plane, hiding everything in front of it.
   *
   * In world space rather than view space: a section is a fact about the part, and clipping
   * against the camera would slice a different half every time the model was orbited.
   */
  section?: { normal: [number, number, number]; offset: number } | null;
}

export interface GeometryBuffers {
  triangleCount: number;
  edgeCount: number;
}

export class SolidRenderer {
  private readonly gl: WebGL2RenderingContext;

  private solidProgram: WebGLProgram | null = null;
  private edgeProgram: WebGLProgram | null = null;
  private pickProgram: WebGLProgram | null = null;

  private solidVao: WebGLVertexArrayObject | null = null;
  private edgeVao: WebGLVertexArrayObject | null = null;
  private pickVao: WebGLVertexArrayObject | null = null;

  private positionBuffer: WebGLBuffer | null = null;
  private normalBuffer: WebGLBuffer | null = null;
  private faceIdBuffer: WebGLBuffer | null = null;
  private edgeBuffer: WebGLBuffer | null = null;

  private pickFbo: WebGLFramebuffer | null = null;
  private pickTexture: WebGLTexture | null = null;
  private pickDepth: WebGLRenderbuffer | null = null;
  private pickSize: [number, number] = [0, 0];
  private pickedTexture: WebGLTexture | null = null;
  private faceColourTexture: WebGLTexture | null = null;

  private counts: GeometryBuffers = { triangleCount: 0, edgeCount: 0 };
  private modelScale = 1;

  /** Set when the context is lost, so draws become no-ops instead of throwing. */
  private lost = false;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      depth: true,
      // A CAD viewport is opaque; letting the page show through costs a blend and gains
      // nothing.
      alpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    canvas.addEventListener('webglcontextlost', (e) => {
      // Without preventDefault the context never comes back, and the viewport is dead until
      // the page is reloaded. This happens on GPU driver resets, which are not rare.
      e.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.initPrograms();
    });

    this.initPrograms();

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    // Back faces are kept. Culling them makes the inside of a bore invisible, and a section
    // view show nothing at all.
    gl.disable(gl.CULL_FACE);
  }

  private initPrograms(): void {
    this.solidProgram = this.link(SOLID_VS, SOLID_FS);
    this.edgeProgram = this.link(EDGE_VS, EDGE_FS);
    this.pickProgram = this.link(PICK_VS, PICK_FS);
  }

  private link(vsSource: string, fsSource: string): WebGLProgram {
    const gl = this.gl;
    const vs = this.compile(gl.VERTEX_SHADER, vsSource);
    const fs = this.compile(gl.FRAGMENT_SHADER, fsSource);

    const program = gl.createProgram();
    if (!program) throw new Error('Could not create a shader program');

    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      throw new Error(`Shader link failed: ${log}`);
    }

    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return program;
  }

  private compile(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Could not create a shader');

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Shader compile failed: ${log}`);
    }
    return shader;
  }

  /**
   * Uploads a solid.
   *
   * The shading mesh splits vertices at sharp edges so a machined block reads as crisp
   * rather than pillowed, and carries the face id per vertex so the fragment shader can
   * colour selection without a second draw call.
   */
  setMesh(mesh: Mesh, creaseDeg = 35): GeometryBuffers {
    const shaded = shadingMesh(mesh, creaseDeg);

    this.positionBuffer = this.upload(this.positionBuffer, shaded.positions);
    this.normalBuffer = this.upload(this.normalBuffer, shaded.normals);
    this.faceIdBuffer = this.upload(this.faceIdBuffer, Float32Array.from(shaded.faceIds));

    // A rough scale for the depth bias, so edges sit correctly on a 5 mm part and a 5 m one.
    let maxExtent = 1;
    for (let i = 0; i < shaded.positions.length; i++) {
      const v = Math.abs(shaded.positions[i]);
      if (v > maxExtent) maxExtent = v;
    }
    this.modelScale = maxExtent;

    this.solidVao = this.buildSolidVao();
    this.pickVao = this.buildPickVao();

    this.counts.triangleCount = shaded.positions.length / 9;
    return this.counts;
  }

  /** Uploads the edge line list produced by the document's edge extraction. */
  setEdges(positions: Float32Array): void {
    this.edgeBuffer = this.upload(this.edgeBuffer, positions);
    this.edgeVao = this.buildEdgeVao();
    this.counts.edgeCount = positions.length / 6;
  }

  private upload(buffer: WebGLBuffer | null, data: Float32Array): WebGLBuffer {
    const gl = this.gl;
    const b = buffer ?? gl.createBuffer();
    if (!b) throw new Error('Could not create a buffer');
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return b;
  }

  private buildSolidVao(): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao || !this.solidProgram) throw new Error('Could not create a vertex array');

    gl.bindVertexArray(vao);
    this.bindAttrib(this.solidProgram, 'aPosition', this.positionBuffer, 3);
    this.bindAttrib(this.solidProgram, 'aNormal', this.normalBuffer, 3);
    this.bindAttrib(this.solidProgram, 'aFaceId', this.faceIdBuffer, 1);
    gl.bindVertexArray(null);
    return vao;
  }

  private buildPickVao(): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao || !this.pickProgram) throw new Error('Could not create a vertex array');

    gl.bindVertexArray(vao);
    this.bindAttrib(this.pickProgram, 'aPosition', this.positionBuffer, 3);
    this.bindAttrib(this.pickProgram, 'aFaceId', this.faceIdBuffer, 1);
    gl.bindVertexArray(null);
    return vao;
  }

  private buildEdgeVao(): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao || !this.edgeProgram) throw new Error('Could not create a vertex array');

    gl.bindVertexArray(vao);
    this.bindAttrib(this.edgeProgram, 'aPosition', this.edgeBuffer, 3);
    gl.bindVertexArray(null);
    return vao;
  }

  private bindAttrib(program: WebGLProgram, name: string, buffer: WebGLBuffer | null, size: number): void {
    const gl = this.gl;
    const loc = gl.getAttribLocation(program, name);
    if (loc < 0 || !buffer) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }

  render(width: number, height: number, opts: RenderOptions): void {
    const gl = this.gl;
    if (this.lost || !this.solidProgram) return;

    gl.viewport(0, 0, width, height);

    const bg = opts.dark ? [0.055, 0.067, 0.09] : [0.93, 0.94, 0.96];
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (this.counts.triangleCount === 0) return;

    // ── solid ──
    gl.useProgram(this.solidProgram);
    this.setMat4(this.solidProgram, 'uView', opts.view);
    this.setMat4(this.solidProgram, 'uProjection', opts.projection);

    const base = opts.dark ? [0.62, 0.66, 0.72] : [0.70, 0.73, 0.78];
    this.setVec3(this.solidProgram, 'uBaseColour', base);
    this.setVec3(this.solidProgram, 'uSelectedColour', [0.29, 0.62, 1.0]);
    this.setVec3(this.solidProgram, 'uHoverColour', [0.45, 0.74, 1.0]);
    // Amber for a deliberate pick, so it reads as different from the blue of "this is the
    // feature you are editing" rather than as a shade of the same thing.
    this.setVec3(this.solidProgram, 'uPickedColour', [1.0, 0.68, 0.24]);
    this.setFloat(this.solidProgram, 'uHoverFace', opts.hoverFace);
    this.uploadPicked(opts.pickedFaces);
    const section = opts.section ?? null;
    this.setBool(this.solidProgram, 'uSectionOn', section !== null);
    this.setVec3(this.solidProgram, 'uSectionNormal', section ? section.normal : [0, 0, 1]);
    this.setFloat(this.solidProgram, 'uSectionOffset', section ? section.offset : 0);

    this.setFloat(this.solidProgram, 'uSelectedFeatureLo', opts.selectedFeatureRange[0]);
    this.setFloat(this.solidProgram, 'uSelectedFeatureHi', opts.selectedFeatureRange[1]);

    gl.bindVertexArray(this.solidVao);
    gl.drawArrays(gl.TRIANGLES, 0, this.counts.triangleCount * 3);

    // ── edges ──
    if (opts.showEdges && this.counts.edgeCount > 0 && this.edgeProgram) {
      gl.useProgram(this.edgeProgram);
      this.setMat4(this.edgeProgram, 'uView', opts.view);
      this.setMat4(this.edgeProgram, 'uProjection', opts.projection);
      this.setVec3(this.edgeProgram, 'uColour', opts.dark ? [0.08, 0.09, 0.12] : [0.15, 0.17, 0.2]);
      this.setFloat(this.edgeProgram, 'uAlpha', 0.85);
      // Scaled to the model so the same bias works on a 5 mm part and a 5 m one.
      this.setFloat(this.edgeProgram, 'uDepthBias', this.modelScale * 0.002 + 0.01);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(this.edgeVao);
      gl.drawArrays(gl.LINES, 0, this.counts.edgeCount * 2);
      gl.disable(gl.BLEND);
    }

    gl.bindVertexArray(null);
  }

  /**
   * Reads the face id under a pixel.
   *
   * Rendering ids to an off-screen buffer and reading one pixel is exact — it picks whatever
   * the user can actually see, including a face one pixel wide — and costs one draw instead
   * of a ray cast against every triangle. Returns -1 for empty space.
   */
  pick(x: number, y: number, width: number, height: number, view: Mat4, projection: Mat4): number {
    const gl = this.gl;
    if (this.lost || !this.pickProgram || this.counts.triangleCount === 0) return -1;

    this.ensurePickTarget(width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.pickProgram);
    this.setMat4(this.pickProgram, 'uView', view);
    this.setMat4(this.pickProgram, 'uProjection', projection);
    gl.bindVertexArray(this.pickVao);
    gl.drawArrays(gl.TRIANGLES, 0, this.counts.triangleCount * 3);

    const pixel = new Uint8Array(4);
    // WebGL's origin is bottom-left; pointer coordinates are top-left.
    gl.readPixels(x, height - y - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);

    const id = pixel[0] | (pixel[1] << 8) | (pixel[2] << 16);
    return id === 0 ? -1 : id - 1;
  }

  private ensurePickTarget(width: number, height: number): void {
    const gl = this.gl;
    if (this.pickFbo && this.pickSize[0] === width && this.pickSize[1] === height) return;

    if (this.pickTexture) gl.deleteTexture(this.pickTexture);
    if (this.pickDepth) gl.deleteRenderbuffer(this.pickDepth);
    if (this.pickFbo) gl.deleteFramebuffer(this.pickFbo);

    this.pickTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.pickTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    // Nearest filtering: an interpolated id is a different, wrong id.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    this.pickDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);

    this.pickFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTexture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.pickDepth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.pickSize = [width, height];
  }

  /**
   * Uploads the picked-face set as a single-channel texture.
   *
   * Square, side chosen from the highest face id, so the whole thing is one small upload
   * regardless of how many faces are picked or how sparse the ids are.
   */
  private uploadPicked(faces: number[]): void {
    const gl = this.gl;
    if (!this.solidProgram) return;

    const has = faces.length > 0;
    this.setBool(this.solidProgram, 'uHasPicked', has);
    if (!has) { this.setFloat(this.solidProgram, 'uPickedWidth', 1); return; }

    let highest = 0;
    for (const f of faces) if (f > highest) highest = f;
    const width = Math.max(1, Math.ceil(Math.sqrt(highest + 1)));

    const data = new Uint8Array(width * width);
    for (const f of faces) if (f >= 0 && f < data.length) data[f] = 255;

    if (!this.pickedTexture) this.pickedTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.pickedTexture);
    // One byte per face; alignment must be relaxed or a non-multiple-of-four width is
    // read with padding that does not exist and the selection appears shifted.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, width, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const loc = gl.getUniformLocation(this.solidProgram, 'uPicked');
    if (loc) gl.uniform1i(loc, 0);
    this.setFloat(this.solidProgram, 'uPickedWidth', width);
  }

  /**
   * Each face's colour, as a texture indexed by face id.
   *
   * Uploaded only when the colouring changes rather than every frame: the array is rebuilt
   * when the model rebuilds, which is exactly when a face can have acquired a new colour.
   *
   * Texture unit 1, because unit 0 belongs to the picked-face bitmap and both are sampled in
   * the same pass.
   */
  setFaceColours(colours: Float32Array | null): void {
    const gl = this.gl;
    if (!this.solidProgram) return;
    gl.useProgram(this.solidProgram);

    const has = !!colours && colours.length >= 3;
    this.setBool(this.solidProgram, 'uHasFaceColour', has);
    if (!has) { this.setFloat(this.solidProgram, 'uFaceColourWidth', 1); return; }

    const faces = Math.floor(colours!.length / 3);
    const width = Math.max(1, Math.ceil(Math.sqrt(faces)));

    // RGB per face, padded out to the square the shader indexes into.
    const data = new Uint8Array(width * width * 3);
    for (let i = 0; i < faces; i++) {
      for (let k = 0; k < 3; k++) {
        data[i * 3 + k] = Math.round(Math.max(0, Math.min(1, colours![i * 3 + k]!)) * 255);
      }
    }

    if (!this.faceColourTexture) this.faceColourTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.faceColourTexture);
    // Three bytes per texel: alignment must be relaxed, or a width that is not a multiple of
    // four is read with padding that is not there and every colour shifts along the row.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, width, width, 0, gl.RGB, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const loc = gl.getUniformLocation(this.solidProgram, 'uFaceColour');
    if (loc) gl.uniform1i(loc, 1);
    this.setFloat(this.solidProgram, 'uFaceColourWidth', width);
    gl.activeTexture(gl.TEXTURE0);
  }

  private setBool(program: WebGLProgram, name: string, v: boolean): void {
    const loc = this.gl.getUniformLocation(program, name);
    if (loc) this.gl.uniform1i(loc, v ? 1 : 0);
  }

  private setMat4(program: WebGLProgram, name: string, m: Mat4): void {
    const loc = this.gl.getUniformLocation(program, name);
    if (loc) this.gl.uniformMatrix4fv(loc, false, new Float32Array(m));
  }

  private setVec3(program: WebGLProgram, name: string, v: number[]): void {
    const loc = this.gl.getUniformLocation(program, name);
    if (loc) this.gl.uniform3f(loc, v[0], v[1], v[2]);
  }

  private setFloat(program: WebGLProgram, name: string, v: number): void {
    const loc = this.gl.getUniformLocation(program, name);
    if (loc) this.gl.uniform1f(loc, v);
  }

  dispose(): void {
    const gl = this.gl;
    for (const b of [this.positionBuffer, this.normalBuffer, this.faceIdBuffer, this.edgeBuffer]) {
      if (b) gl.deleteBuffer(b);
    }
    for (const v of [this.solidVao, this.edgeVao, this.pickVao]) {
      if (v) gl.deleteVertexArray(v);
    }
    for (const p of [this.solidProgram, this.edgeProgram, this.pickProgram]) {
      if (p) gl.deleteProgram(p);
    }
    if (this.pickTexture) gl.deleteTexture(this.pickTexture);
    if (this.pickedTexture) gl.deleteTexture(this.pickedTexture);
    if (this.faceColourTexture) gl.deleteTexture(this.faceColourTexture);
    if (this.pickDepth) gl.deleteRenderbuffer(this.pickDepth);
    if (this.pickFbo) gl.deleteFramebuffer(this.pickFbo);
  }
}

/** True when the browser can render at all, so the UI can offer a reason rather than a blank box. */
export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}
