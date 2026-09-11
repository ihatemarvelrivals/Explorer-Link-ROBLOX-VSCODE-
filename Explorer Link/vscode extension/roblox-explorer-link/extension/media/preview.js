/*
 * 3D preview renderer.
 *
 * A small hand-written WebGL renderer rather than a library: a webview has no network
 * access to a CDN and this extension ships no runtime dependencies, so pulling in
 * Three.js would mean vendoring half a megabyte to draw five primitives. Five primitives
 * is what this does.
 *
 * Everything above the "browser half" marker is pure and exported for tests when this
 * file is required from Node.
 */

(function (global) {
  'use strict';

  // =========================================================================
  // matrix math — column-major, the layout WebGL wants
  // =========================================================================

  function perspective(fovYRadians, aspect, near, far) {
    const f = 1 / Math.tan(fovYRadians / 2);
    const range = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (near + far) * range, -1,
      0, 0, near * far * range * 2, 0,
    ]);
  }

  function normalize(v) {
    const length = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / length, v[1] / length, v[2] / length];
  }

  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }

  function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  function lookAt(eye, target, up) {
    const forward = normalize([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
    let right = cross(forward, up);
    if (Math.hypot(right[0], right[1], right[2]) < 1e-6) {
      // Looking straight along `up`: pick any perpendicular so the view stays valid.
      right = cross(forward, [0, 0, 1]);
    }
    right = normalize(right);
    const trueUp = cross(right, forward);
    return new Float32Array([
      right[0], trueUp[0], -forward[0], 0,
      right[1], trueUp[1], -forward[1], 0,
      right[2], trueUp[2], -forward[2], 0,
      -dot(right, eye), -dot(trueUp, eye), dot(forward, eye), 1,
    ]);
  }

  /**
   * Turns a Roblox CFrame plus a part Size into a model matrix.
   *
   * CFrame:GetComponents returns x, y, z then the rotation matrix row by row
   * (R00 R01 R02 / R10 R11 R12 / R20 R21 R22). A column-major GL matrix wants those
   * rows read down the columns, each column scaled by that axis's size.
   */
  function modelMatrix(cframe, size) {
    const x = cframe[0];
    const y = cframe[1];
    const z = cframe[2];
    const sx = size[0];
    const sy = size[1];
    const sz = size[2];
    return new Float32Array([
      cframe[3] * sx, cframe[6] * sx, cframe[9] * sx, 0,
      cframe[4] * sy, cframe[7] * sy, cframe[10] * sy, 0,
      cframe[5] * sz, cframe[8] * sz, cframe[11] * sz, 0,
      x, y, z, 1,
    ]);
  }

  /**
   * The inverse-transpose of the model matrix's rotation+scale, as a 3x3. Non-uniform
   * part sizes are the norm in Roblox, so without this a stretched part lights wrongly.
   */
  function normalMatrix(cframe, size) {
    const sx = size[0] || 1;
    const sy = size[1] || 1;
    const sz = size[2] || 1;
    return new Float32Array([
      cframe[3] / sx, cframe[6] / sx, cframe[9] / sx,
      cframe[4] / sy, cframe[7] / sy, cframe[10] / sy,
      cframe[5] / sz, cframe[8] / sz, cframe[11] / sz,
    ]);
  }

  /** Transforms a local point by a part's CFrame and Size. */
  function transformPoint(cframe, size, point) {
    const lx = point[0] * size[0];
    const ly = point[1] * size[1];
    const lz = point[2] * size[2];
    return [
      cframe[0] + cframe[3] * lx + cframe[4] * ly + cframe[5] * lz,
      cframe[1] + cframe[6] * lx + cframe[7] * ly + cframe[8] * lz,
      cframe[2] + cframe[9] * lx + cframe[10] * ly + cframe[11] * lz,
    ];
  }

  const BOX_CORNERS = [
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5],
  ];

  /**
   * World-space bounds of a part list. Every shape fits inside its own box, so the box
   * corners are enough for all of them — a sphere never escapes its bounding box.
   */
  function computeBounds(parts) {
    if (!parts || parts.length === 0) {
      return { min: [-1, -1, -1], max: [1, 1, 1], center: [0, 0, 0], radius: 1 };
    }
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];

    for (const part of parts) {
      for (const corner of BOX_CORNERS) {
        const world = transformPoint(part.cframe, part.size, corner);
        for (let axis = 0; axis < 3; axis += 1) {
          if (world[axis] < min[axis]) min[axis] = world[axis];
          if (world[axis] > max[axis]) max[axis] = world[axis];
        }
      }
    }

    const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const radius = Math.max(
      0.5,
      Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2,
    );
    return { min, max, center, radius };
  }

  // =========================================================================
  // primitive meshes — unit sized, scaled per part by the model matrix
  // =========================================================================

  /**
   * Roblox's wedge and corner-wedge orientation is a convention, not something the API
   * reports. WEDGE_TALL_SIDE says which end of the Z axis keeps full height: +1 puts the
   * vertical face at +Z (Back). If wedges ever look mirrored, this is the one line to
   * flip.
   */
  const WEDGE_TALL_SIDE = 1;

  function flatMesh(triangles) {
    const positions = [];
    const normals = [];
    for (const [a, b, c] of triangles) {
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = normalize(cross(u, v));
      for (const vertex of [a, b, c]) {
        positions.push(vertex[0], vertex[1], vertex[2]);
        normals.push(n[0], n[1], n[2]);
      }
    }
    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      count: positions.length / 3,
    };
  }

  function quad(a, b, c, d) {
    return [[a, b, c], [a, c, d]];
  }

  function buildBox() {
    const [nnn, pnn, npn, ppn, nnp, pnp, npp, ppp] = BOX_CORNERS;
    return flatMesh([
      ...quad(nnp, pnp, ppp, npp), // +Z
      ...quad(pnn, nnn, npn, ppn), // -Z
      ...quad(npn, npp, ppp, ppn), // +Y
      ...quad(nnn, pnn, pnp, nnp), // -Y
      ...quad(pnp, pnn, ppn, ppp), // +X
      ...quad(nnn, nnp, npp, npn), // -X
    ]);
  }

  /** Unit sphere of radius 0.5; a non-uniform part size makes it the ellipsoid Roblox draws. */
  function buildBall(segments, rings) {
    segments = segments || 20;
    rings = rings || 14;
    const triangles = [];
    const at = (ring, segment) => {
      const phi = (ring / rings) * Math.PI;
      const theta = (segment / segments) * Math.PI * 2;
      return [
        0.5 * Math.sin(phi) * Math.cos(theta),
        0.5 * Math.cos(phi),
        0.5 * Math.sin(phi) * Math.sin(theta),
      ];
    };
    for (let ring = 0; ring < rings; ring += 1) {
      for (let segment = 0; segment < segments; segment += 1) {
        const a = at(ring, segment);
        const b = at(ring + 1, segment);
        const c = at(ring + 1, segment + 1);
        const d = at(ring, segment + 1);
        if (ring !== 0) triangles.push([a, b, c]);
        if (ring !== rings - 1) triangles.push([a, c, d]);
      }
    }

    // Smooth normals make a sphere look like a sphere; flat shading would facet it.
    const mesh = flatMesh(triangles);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const n = normalize([mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]);
      mesh.normals[i] = n[0];
      mesh.normals[i + 1] = n[1];
      mesh.normals[i + 2] = n[2];
    }
    return mesh;
  }

  /** Roblox cylinders run along X: the circular faces are the Right and Left faces. */
  function buildCylinder(segments) {
    segments = segments || 24;
    const triangles = [];
    const ring = (segment) => {
      const theta = (segment / segments) * Math.PI * 2;
      return [0.5 * Math.cos(theta), 0.5 * Math.sin(theta)];
    };
    for (let segment = 0; segment < segments; segment += 1) {
      const [y0, z0] = ring(segment);
      const [y1, z1] = ring(segment + 1);
      triangles.push(
        [[-0.5, y0, z0], [0.5, y0, z0], [0.5, y1, z1]],
        [[-0.5, y0, z0], [0.5, y1, z1], [-0.5, y1, z1]],
        [[0.5, 0, 0], [0.5, y0, z0], [0.5, y1, z1]],
        [[-0.5, 0, 0], [-0.5, y1, z1], [-0.5, y0, z0]],
      );
    }
    return flatMesh(triangles);
  }

  function buildWedge() {
    const tall = 0.5 * WEDGE_TALL_SIDE;
    const short = -0.5 * WEDGE_TALL_SIDE;
    // Bottom square, plus a top edge only over the tall side.
    const b0 = [-0.5, -0.5, short];
    const b1 = [0.5, -0.5, short];
    const b2 = [0.5, -0.5, tall];
    const b3 = [-0.5, -0.5, tall];
    const t0 = [-0.5, 0.5, tall];
    const t1 = [0.5, 0.5, tall];
    return flatMesh([
      ...quad(b0, b1, b2, b3), // bottom
      [b3, b2, t1], [b3, t1, t0], // vertical face on the tall side
      [b0, t0, t1], [b0, t1, b1], // the slope
      [b0, b3, t0], // left triangle
      [b1, t1, b2], // right triangle
    ]);
  }

  function buildCornerWedge() {
    const tall = 0.5 * WEDGE_TALL_SIDE;
    const short = -0.5 * WEDGE_TALL_SIDE;
    // A corner pyramid: bottom square with a single apex above one corner.
    const b0 = [-0.5, -0.5, short];
    const b1 = [0.5, -0.5, short];
    const b2 = [0.5, -0.5, tall];
    const b3 = [-0.5, -0.5, tall];
    const apex = [0.5, 0.5, tall];
    return flatMesh([
      ...quad(b0, b1, b2, b3), // bottom
      [b1, apex, b2], // vertical face on +X
      [b3, b2, apex], // vertical face on the tall side
      [b0, apex, b1], // slope one
      [b0, b3, apex], // slope two
    ]);
  }

  /** Line-list edges of the unit box, for outlining approximated parts. */
  function buildBoxEdges() {
    const pairs = [
      [0, 1], [1, 3], [3, 2], [2, 0],
      [4, 5], [5, 7], [7, 6], [6, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    const positions = [];
    for (const [a, b] of pairs) {
      positions.push(...BOX_CORNERS[a], ...BOX_CORNERS[b]);
    }
    return { positions: new Float32Array(positions), count: positions.length / 3 };
  }

  const MESH_BUILDERS = {
    box: buildBox,
    ball: buildBall,
    cylinder: buildCylinder,
    wedge: buildWedge,
    cornerwedge: buildCornerWedge,
  };

  const pure = {
    perspective,
    lookAt,
    modelMatrix,
    normalMatrix,
    transformPoint,
    computeBounds,
    buildBox,
    buildBall,
    buildCylinder,
    buildWedge,
    buildCornerWedge,
    buildBoxEdges,
    MESH_BUILDERS,
    WEDGE_TALL_SIDE,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = pure;
  }
  if (typeof document === 'undefined') {
    return;
  }

  // =========================================================================
  // browser half
  // =========================================================================

  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;

  const canvas = document.getElementById('stage');
  const empty = document.getElementById('empty');
  const heading = document.getElementById('heading');
  const detail = document.getElementById('detail');
  const badge = document.getElementById('badge');

  const gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false });
  if (!gl) {
    empty.textContent = 'This VS Code build has no WebGL available, so the preview cannot draw.';
    empty.hidden = false;
    return;
  }

  const SOLID_VERTEX = `
    attribute vec3 aPos;
    attribute vec3 aNormal;
    uniform mat4 uModel, uView, uProj;
    uniform mat3 uNormalMatrix;
    varying vec3 vNormal;
    void main() {
      vNormal = normalize(uNormalMatrix * aNormal);
      gl_Position = uProj * uView * uModel * vec4(aPos, 1.0);
    }`;

  const SOLID_FRAGMENT = `
    precision mediump float;
    uniform vec3 uColor;
    uniform float uAlpha;
    varying vec3 vNormal;
    void main() {
      vec3 n = normalize(vNormal);
      // Two lights and a strong ambient: a preview should read clearly from every
      // angle, which matters more here than physical plausibility.
      float key = max(dot(n, normalize(vec3(0.45, 0.8, 0.35))), 0.0);
      float fill = max(dot(n, normalize(vec3(-0.5, 0.25, -0.6))), 0.0);
      float lit = 0.42 + key * 0.62 + fill * 0.22;
      gl_FragColor = vec4(uColor * lit, uAlpha);
    }`;

  const LINE_VERTEX = `
    attribute vec3 aPos;
    uniform mat4 uModel, uView, uProj;
    void main() { gl_Position = uProj * uView * uModel * vec4(aPos, 1.0); }`;

  const LINE_FRAGMENT = `
    precision mediump float;
    uniform vec3 uColor;
    uniform float uAlpha;
    void main() { gl_FragColor = vec4(uColor, uAlpha); }`;

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || 'shader compile failed');
    }
    return shader;
  }

  function link(vertexSource, fragmentSource) {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'program link failed');
    }
    return program;
  }

  const solid = link(SOLID_VERTEX, SOLID_FRAGMENT);
  const lines = link(LINE_VERTEX, LINE_FRAGMENT);

  const solidLoc = {
    pos: gl.getAttribLocation(solid, 'aPos'),
    normal: gl.getAttribLocation(solid, 'aNormal'),
    model: gl.getUniformLocation(solid, 'uModel'),
    view: gl.getUniformLocation(solid, 'uView'),
    proj: gl.getUniformLocation(solid, 'uProj'),
    normalMatrix: gl.getUniformLocation(solid, 'uNormalMatrix'),
    color: gl.getUniformLocation(solid, 'uColor'),
    alpha: gl.getUniformLocation(solid, 'uAlpha'),
  };
  const lineLoc = {
    pos: gl.getAttribLocation(lines, 'aPos'),
    model: gl.getUniformLocation(lines, 'uModel'),
    view: gl.getUniformLocation(lines, 'uView'),
    proj: gl.getUniformLocation(lines, 'uProj'),
    color: gl.getUniformLocation(lines, 'uColor'),
    alpha: gl.getUniformLocation(lines, 'uAlpha'),
  };

  function uploadMesh(mesh) {
    const positions = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positions);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);

    let normals = null;
    if (mesh.normals) {
      normals = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, normals);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
    }
    return { positions, normals, count: mesh.count };
  }

  const meshes = {};
  for (const [name, build] of Object.entries(MESH_BUILDERS)) {
    meshes[name] = uploadMesh(build());
  }
  const boxEdges = uploadMesh(buildBoxEdges());

  // Ground grid, rebuilt whenever the model's footprint changes.
  let grid = null;
  function buildGrid(bounds) {
    const span = Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2], 4);
    const step = Math.pow(2, Math.round(Math.log2(span / 8)));
    const half = Math.ceil(span * 0.8 / step) * step;
    const y = bounds.min[1];
    const cx = Math.round(bounds.center[0] / step) * step;
    const cz = Math.round(bounds.center[2] / step) * step;
    const positions = [];
    for (let offset = -half; offset <= half; offset += step) {
      positions.push(cx + offset, y, cz - half, cx + offset, y, cz + half);
      positions.push(cx - half, y, cz + offset, cx + half, y, cz + offset);
    }
    if (grid) {
      gl.deleteBuffer(grid.positions);
    }
    grid = uploadMesh({ positions: new Float32Array(positions), count: positions.length / 3 });
  }

  const FOV_Y = (50 * Math.PI) / 180;

  const camera = { yaw: 0.7, pitch: 0.5, distance: 20, target: [0, 0, 0] };
  let model = null;
  let bounds = computeBounds(null);
  // Once the user orbits or zooms, a resize must not yank the camera back.
  let cameraTouched = false;

  /**
   * Distance at which the model's bounding sphere just fits. The panel in a sidebar is
   * usually taller than it is wide, where the horizontal field of view is the binding
   * constraint — fitting to the vertical one alone would crop the sides.
   */
  function fitDistance() {
    const aspect = Math.max(0.2, canvas.clientWidth / Math.max(1, canvas.clientHeight));
    const halfVertical = FOV_Y / 2;
    const halfHorizontal = Math.atan(Math.tan(halfVertical) * aspect);
    const limiting = Math.min(halfVertical, halfHorizontal);
    return (bounds.radius / Math.sin(limiting)) * 1.08;
  }

  function frameModel() {
    bounds = computeBounds(model ? model.parts : null);
    camera.target = bounds.center.slice();
    camera.yaw = 0.7;
    camera.pitch = 0.5;
    camera.distance = fitDistance();
    cameraTouched = false;
    buildGrid(bounds);
  }

  function themeColor(name, fallback) {
    const value = getComputedStyle(document.body).getPropertyValue(name).trim();
    if (!value.startsWith('#') || (value.length !== 7 && value.length !== 4)) {
      return fallback;
    }
    const expand = value.length === 4
      ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
      : value;
    return [
      parseInt(expand.slice(1, 3), 16) / 255,
      parseInt(expand.slice(3, 5), 16) / 255,
      parseInt(expand.slice(5, 7), 16) / 255,
    ];
  }

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  function bindSolid(mesh) {
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.positions);
    gl.enableVertexAttribArray(solidLoc.pos);
    gl.vertexAttribPointer(solidLoc.pos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normals);
    gl.enableVertexAttribArray(solidLoc.normal);
    gl.vertexAttribPointer(solidLoc.normal, 3, gl.FLOAT, false, 0, 0);
  }

  function draw() {
    resize();
    gl.viewport(0, 0, canvas.width, canvas.height);

    const background = themeColor('--vscode-editor-background', [0.12, 0.12, 0.13]);
    gl.clearColor(background[0], background[1], background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    if (!model || model.parts.length === 0) {
      return;
    }

    const cosPitch = Math.cos(camera.pitch);
    const eye = [
      camera.target[0] + camera.distance * cosPitch * Math.sin(camera.yaw),
      camera.target[1] + camera.distance * Math.sin(camera.pitch),
      camera.target[2] + camera.distance * cosPitch * Math.cos(camera.yaw),
    ];
    const view = lookAt(eye, camera.target, [0, 1, 0]);
    const proj = perspective(
      FOV_Y,
      canvas.width / Math.max(1, canvas.height),
      Math.max(0.05, camera.distance / 400),
      camera.distance * 12 + 200,
    );

    // Grid first, under everything.
    const gridColor = themeColor('--vscode-panel-border', [0.35, 0.35, 0.38]);
    gl.useProgram(lines);
    gl.uniformMatrix4fv(lineLoc.view, false, view);
    gl.uniformMatrix4fv(lineLoc.proj, false, proj);
    gl.uniformMatrix4fv(lineLoc.model, false, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
    gl.uniform3fv(lineLoc.color, gridColor);
    gl.uniform1f(lineLoc.alpha, 0.5);
    gl.bindBuffer(gl.ARRAY_BUFFER, grid.positions);
    gl.enableVertexAttribArray(lineLoc.pos);
    gl.vertexAttribPointer(lineLoc.pos, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.LINES, 0, grid.count);

    // Opaque, then transparent back-to-front. Sorting by distance from the eye is
    // enough for a preview and avoids the sorting artefacts of drawing in tree order.
    const opaque = [];
    const clear = [];
    for (const part of model.parts) {
      (part.transparency > 0.02 ? clear : opaque).push(part);
    }
    clear.sort((a, b) => {
      const da = Math.hypot(a.cframe[0] - eye[0], a.cframe[1] - eye[1], a.cframe[2] - eye[2]);
      const db = Math.hypot(b.cframe[0] - eye[0], b.cframe[1] - eye[1], b.cframe[2] - eye[2]);
      return db - da;
    });

    gl.useProgram(solid);
    gl.uniformMatrix4fv(solidLoc.view, false, view);
    gl.uniformMatrix4fv(solidLoc.proj, false, proj);

    const drawPart = (part) => {
      const mesh = meshes[part.shape] || meshes.box;
      bindSolid(mesh);
      gl.uniformMatrix4fv(solidLoc.model, false, modelMatrix(part.cframe, part.size));
      gl.uniformMatrix3fv(solidLoc.normalMatrix, false, normalMatrix(part.cframe, part.size));
      gl.uniform3fv(solidLoc.color, part.color);
      gl.uniform1f(solidLoc.alpha, 1 - part.transparency);
      gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
    };

    gl.disable(gl.BLEND);
    gl.depthMask(true);
    for (const part of opaque) drawPart(part);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    for (const part of clear) drawPart(part);
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    // Outline anything drawn as a stand-in, so an approximated mesh never passes for
    // the real shape.
    const approximate = model.parts.filter((part) => part.approximate);
    if (approximate.length > 0) {
      gl.useProgram(lines);
      gl.uniformMatrix4fv(lineLoc.view, false, view);
      gl.uniformMatrix4fv(lineLoc.proj, false, proj);
      gl.uniform3fv(lineLoc.color, themeColor('--vscode-charts-orange', [0.9, 0.6, 0.25]));
      gl.uniform1f(lineLoc.alpha, 0.85);
      gl.bindBuffer(gl.ARRAY_BUFFER, boxEdges.positions);
      gl.enableVertexAttribArray(lineLoc.pos);
      gl.vertexAttribPointer(lineLoc.pos, 3, gl.FLOAT, false, 0, 0);
      for (const part of approximate) {
        gl.uniformMatrix4fv(lineLoc.model, false, modelMatrix(part.cframe, part.size));
        gl.drawArrays(gl.LINES, 0, boxEdges.count);
      }
    }
  }

  let frameRequested = false;
  function invalidate() {
    if (frameRequested) {
      return;
    }
    frameRequested = true;
    requestAnimationFrame(() => {
      frameRequested = false;
      try {
        draw();
      } catch (error) {
        console.error('[explorer-link preview]', error);
      }
    });
  }

  // -- interaction ----------------------------------------------------------

  let dragging = null;
  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    dragging = {
      x: event.clientX,
      y: event.clientY,
      pan: event.shiftKey || event.button === 1 || event.button === 2,
    };
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) {
      return;
    }
    const dx = event.clientX - dragging.x;
    const dy = event.clientY - dragging.y;
    dragging.x = event.clientX;
    dragging.y = event.clientY;

    if (dragging.pan) {
      // Pan along the camera's own right and up axes so dragging feels direct.
      const right = [Math.cos(camera.yaw), 0, -Math.sin(camera.yaw)];
      const scale = camera.distance / 600;
      camera.target[0] -= (right[0] * dx) * scale;
      camera.target[2] -= (right[2] * dx) * scale;
      camera.target[1] += dy * scale;
    } else {
      camera.yaw -= dx * 0.01;
      camera.pitch = Math.max(-1.5, Math.min(1.5, camera.pitch + dy * 0.01));
    }
    cameraTouched = true;
    invalidate();
  });

  const endDrag = () => {
    dragging = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const factor = Math.exp(event.deltaY * 0.0015);
    camera.distance = Math.max(bounds.radius * 0.15, Math.min(bounds.radius * 40, camera.distance * factor));
    cameraTouched = true;
    invalidate();
  }, { passive: false });

  canvas.addEventListener('dblclick', () => {
    frameModel();
    invalidate();
  });

  document.getElementById('frame').addEventListener('click', () => {
    frameModel();
    invalidate();
  });

  // Refresh lives on the view's title bar rather than in this strip: at sidebar widths
  // a second button crowds out the instance's name.

  window.addEventListener('resize', () => {
    // Dragging the sidebar wider should reveal more of the model, not the same crop —
    // but only while the user has left the camera alone.
    if (model && !cameraTouched) {
      camera.distance = fitDistance();
    }
    invalidate();
  });
  new MutationObserver(invalidate).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // -- messages from the extension -----------------------------------------

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message) {
      return;
    }

    if (message.type === 'empty') {
      model = null;
      empty.textContent = message.text;
      empty.hidden = false;
      canvas.hidden = true;
      heading.textContent = message.heading || '';
      detail.textContent = '';
      badge.hidden = true;
      invalidate();
      return;
    }

    if (message.type === 'model') {
      model = message.model;
      canvas.hidden = false;
      empty.hidden = true;

      heading.textContent = `${model.name}`;
      const count = model.parts.length;
      const pieces = [`${count} ${count === 1 ? 'part' : 'parts'}`, model.className];
      if (model.truncated) {
        pieces.push(`capped at ${model.maxParts}`);
      }
      detail.textContent = pieces.join(' · ');

      if (model.approximated > 0) {
        badge.hidden = false;
        badge.textContent = `${model.approximated} approx.`;
        badge.title =
          'Meshes and unions have no geometry a plugin can read, so they are drawn as ' +
          'their bounding box and outlined.';
      } else {
        badge.hidden = true;
      }

      frameModel();
      invalidate();
    }
  });

  if (vscode) {
    vscode.postMessage({ type: 'ready' });
  }
  invalidate();
})(typeof globalThis !== 'undefined' ? globalThis : this);
