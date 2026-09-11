#!/usr/bin/env node
/**
 * Tests the maths and mesh building behind the 3D preview.
 *
 * media/preview.js exports its pure half when required from Node, so the parts that can
 * be silently, subtly wrong — the CFrame → model matrix conversion above all — are
 * checked here rather than left to be judged by eye in a 200px panel.
 */

const assert = require('assert');

const preview = require('../media/preview.js');

let passed = 0;
function test(name, body) {
  process.stdout.write(`  ${name} … `);
  body();
  passed += 1;
  console.log('ok');
}

const IDENTITY_CFRAME = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
const close = (a, b, tolerance = 1e-6) =>
  assert.ok(Math.abs(a - b) < tolerance, `expected ${b}, got ${a}`);
const closeVec = (a, b, tolerance = 1e-6) => {
  for (let i = 0; i < b.length; i += 1) {
    close(a[i], b[i], tolerance);
  }
};

// -- transforms -------------------------------------------------------------

test('an identity CFrame with unit size is the identity matrix', () => {
  const m = preview.modelMatrix(IDENTITY_CFRAME, [1, 1, 1]);
  closeVec([...m], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
});

test('position lands in the translation column', () => {
  const m = preview.modelMatrix([3, 4, 5, 1, 0, 0, 0, 1, 0, 0, 0, 1], [1, 1, 1]);
  closeVec([m[12], m[13], m[14]], [3, 4, 5]);
});

test('size scales each basis column independently', () => {
  const m = preview.modelMatrix(IDENTITY_CFRAME, [2, 4, 8]);
  close(m[0], 2);
  close(m[5], 4);
  close(m[10], 8);
});

test('a 90° yaw rotates a local +X point onto world -Z', () => {
  // Roblox CFrame.Angles(0, pi/2, 0): rows are R00..R22 in GetComponents order.
  const c = Math.cos(Math.PI / 2);
  const s = Math.sin(Math.PI / 2);
  const cframe = [0, 0, 0, c, 0, s, 0, 1, 0, -s, 0, c];
  const world = preview.transformPoint(cframe, [1, 1, 1], [1, 0, 0]);
  closeVec(world, [0, 0, -1], 1e-9);
});

test('transformPoint and modelMatrix agree', () => {
  // The renderer transforms vertices with the matrix; bounds use transformPoint. If
  // these two ever disagree, the camera frames something other than what is drawn.
  const cframe = [1, 2, 3, 0.36, -0.48, 0.8, 0.8, 0.6, 0, -0.48, 0.64, 0.6];
  const size = [2, 3, 4];
  const point = [0.5, -0.5, 0.5];

  const viaPoint = preview.transformPoint(cframe, size, point);
  const m = preview.modelMatrix(cframe, size);
  const viaMatrix = [
    m[0] * point[0] + m[4] * point[1] + m[8] * point[2] + m[12],
    m[1] * point[0] + m[5] * point[1] + m[9] * point[2] + m[13],
    m[2] * point[0] + m[6] * point[1] + m[10] * point[2] + m[14],
  ];
  // The matrix is a Float32Array (that is what WebGL takes) while transformPoint works
  // in doubles, so they agree to float precision, not to the last bit.
  closeVec(viaMatrix, viaPoint, 1e-5);
});

test('the normal matrix undoes non-uniform scale', () => {
  // A box stretched 8x on Y must still light as though its top faces straight up.
  const n = preview.normalMatrix(IDENTITY_CFRAME, [1, 8, 1]);
  const normal = [0, 1, 0];
  const out = [
    n[0] * normal[0] + n[3] * normal[1] + n[6] * normal[2],
    n[1] * normal[0] + n[4] * normal[1] + n[7] * normal[2],
    n[2] * normal[0] + n[5] * normal[1] + n[8] * normal[2],
  ];
  const length = Math.hypot(...out);
  closeVec([out[0] / length, out[1] / length, out[2] / length], [0, 1, 0]);
});

test('normalMatrix survives a zero size without dividing by zero', () => {
  const n = preview.normalMatrix(IDENTITY_CFRAME, [0, 0, 0]);
  for (const value of n) {
    assert.ok(Number.isFinite(value), 'normal matrix went non-finite');
  }
});

// -- bounds -----------------------------------------------------------------

test('bounds cover a single part exactly', () => {
  const bounds = preview.computeBounds([{ cframe: [0, 5, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], size: [4, 2, 6] }]);
  closeVec(bounds.min, [-2, 4, -3]);
  closeVec(bounds.max, [2, 6, 3]);
  closeVec(bounds.center, [0, 5, 0]);
});

test('bounds span several parts', () => {
  const bounds = preview.computeBounds([
    { cframe: [-10, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], size: [2, 2, 2] },
    { cframe: [10, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], size: [2, 2, 2] },
  ]);
  closeVec(bounds.min, [-11, -1, -1]);
  closeVec(bounds.max, [11, 1, 1]);
  assert.ok(bounds.radius > 10, 'radius should cover the whole span');
});

test('a rotated part grows its bounds', () => {
  // A long thin part turned 45° about Y occupies more X than its own length/2.
  const c = Math.SQRT1_2;
  const cframe = [0, 0, 0, c, 0, c, 0, 1, 0, -c, 0, c];
  const bounds = preview.computeBounds([{ cframe, size: [10, 1, 1] }]);
  assert.ok(bounds.max[0] > 3.5, `expected the rotated extent to exceed 3.5, got ${bounds.max[0]}`);
  assert.ok(bounds.max[2] > 3.5, 'rotation should extend Z as well');
});

test('empty geometry still yields a usable camera frame', () => {
  const bounds = preview.computeBounds([]);
  assert.ok(bounds.radius > 0, 'radius must stay positive or the camera divides by zero');
  assert.ok(bounds.center.every(Number.isFinite));
});

// -- meshes -----------------------------------------------------------------

test('every shape the plugin can send has a mesh builder', () => {
  // These strings are produced by shapeOf() in the plugin's Commands.lua.
  for (const shape of ['box', 'ball', 'cylinder', 'wedge', 'cornerwedge']) {
    assert.ok(preview.MESH_BUILDERS[shape], `no builder for ${shape}`);
  }
});

test('meshes are well-formed triangle soups', () => {
  for (const [name, build] of Object.entries(preview.MESH_BUILDERS)) {
    const mesh = build();
    assert.ok(mesh.count > 0, `${name} is empty`);
    assert.strictEqual(mesh.count % 3, 0, `${name} has a partial triangle`);
    assert.strictEqual(mesh.positions.length, mesh.count * 3, `${name} position count mismatch`);
    assert.strictEqual(mesh.normals.length, mesh.count * 3, `${name} normal count mismatch`);
    for (const value of mesh.positions) {
      assert.ok(Number.isFinite(value), `${name} has a non-finite position`);
    }
  }
});

test('every primitive fits inside the unit box it will be scaled by', () => {
  // A shape that escaped its own box would poke outside the part in Studio and break
  // the bounds calculation, which assumes the box is the outer limit.
  for (const [name, build] of Object.entries(preview.MESH_BUILDERS)) {
    const mesh = build();
    for (const value of mesh.positions) {
      assert.ok(Math.abs(value) <= 0.5 + 1e-6, `${name} has a vertex outside the unit box: ${value}`);
    }
  }
});

test('normals are unit length', () => {
  for (const [name, build] of Object.entries(preview.MESH_BUILDERS)) {
    const mesh = build();
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const length = Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]);
      assert.ok(Math.abs(length - 1) < 1e-4, `${name} normal ${i / 3} has length ${length}`);
    }
  }
});

test('box faces point outwards', () => {
  // Back-face culling is on, so an inverted winding makes parts invisible from outside.
  const mesh = preview.buildBox();
  for (let i = 0; i < mesh.count; i += 3) {
    const centroid = [0, 0, 0];
    for (let v = 0; v < 3; v += 1) {
      centroid[0] += mesh.positions[(i + v) * 3] / 3;
      centroid[1] += mesh.positions[(i + v) * 3 + 1] / 3;
      centroid[2] += mesh.positions[(i + v) * 3 + 2] / 3;
    }
    const normal = [mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]];
    const outward = centroid[0] * normal[0] + centroid[1] * normal[1] + centroid[2] * normal[2];
    assert.ok(outward > 0, `box triangle ${i / 3} faces inwards`);
  }
});

test('the wedge is half the volume of its box, roughly', () => {
  // A cheap shape sanity check: signed volume via the divergence theorem.
  const volumeOf = (mesh) => {
    let total = 0;
    for (let i = 0; i < mesh.count; i += 3) {
      const p = (n) => [
        mesh.positions[(i + n) * 3],
        mesh.positions[(i + n) * 3 + 1],
        mesh.positions[(i + n) * 3 + 2],
      ];
      const [a, b, c] = [p(0), p(1), p(2)];
      total +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) -
          a[1] * (b[0] * c[2] - b[2] * c[0]) +
          a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
    return Math.abs(total);
  };
  close(volumeOf(preview.buildBox()), 1, 1e-6);
  close(volumeOf(preview.buildWedge()), 0.5, 1e-6);
  // A corner pyramid is a third of its bounding box.
  close(volumeOf(preview.buildCornerWedge()), 1 / 3, 1e-6);
});

test('the sphere is round', () => {
  const mesh = preview.buildBall();
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const r = Math.hypot(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]);
    assert.ok(Math.abs(r - 0.5) < 1e-6, `sphere vertex at radius ${r}`);
  }
});

test('the cylinder runs along X, as Roblox cylinders do', () => {
  const mesh = preview.buildCylinder();
  let maxX = 0;
  let maxYZ = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    maxX = Math.max(maxX, Math.abs(mesh.positions[i]));
    maxYZ = Math.max(maxYZ, Math.hypot(mesh.positions[i + 1], mesh.positions[i + 2]));
  }
  close(maxX, 0.5, 1e-6);
  close(maxYZ, 0.5, 1e-6);
});

test('box edges come in whole line segments', () => {
  const edges = preview.buildBoxEdges();
  assert.strictEqual(edges.count, 24, 'a box has 12 edges, so 24 line vertices');
  assert.strictEqual(edges.count % 2, 0);
});

// -- camera -----------------------------------------------------------------

test('perspective projection is finite and sane', () => {
  const m = preview.perspective(Math.PI / 3, 1.6, 0.1, 1000);
  for (const value of m) {
    assert.ok(Number.isFinite(value));
  }
  assert.strictEqual(m[11], -1, 'the w column should carry -z for a perspective divide');
});

test('lookAt survives a camera directly overhead', () => {
  // pitch clamps below +/-1.5 rad in the UI, but a degenerate up vector must not produce
  // NaNs if it ever gets there.
  const m = preview.lookAt([0, 10, 0], [0, 0, 0], [0, 1, 0]);
  for (const value of m) {
    assert.ok(Number.isFinite(value), 'lookAt went non-finite looking straight down');
  }
});

console.log(`\n${passed} passed`);
