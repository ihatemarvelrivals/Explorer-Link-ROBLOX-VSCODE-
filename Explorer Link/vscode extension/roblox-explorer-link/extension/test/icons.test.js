#!/usr/bin/env node
/**
 * Checks the generated icon map: that lookup lands where it should, that a class the
 * map has never heard of still finds a sensible glyph through its base classes, and
 * that every glyph the map names actually exists on disk.
 *
 * The resolution below mirrors IconResolver.glyphFor. It is duplicated rather than
 * imported because icons.ts imports `vscode`, which does not exist outside an
 * Extension Host — and the part worth testing is the map, not the wrapper.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MEDIA = path.join(__dirname, '..', 'media');
const map = JSON.parse(fs.readFileSync(path.join(MEDIA, 'icon-map.json'), 'utf8'));

function glyphFor(node) {
  if (node.flags?.disabled) {
    return map.disabledOverlay;
  }
  if (map.byClass[node.className]) {
    return map.byClass[node.className];
  }
  for (const tag of node.tags ?? []) {
    if (map.byTag[tag]) {
      return map.byTag[tag];
    }
  }
  if (node.flags?.service) {
    return map.serviceFallback;
  }
  return map.fallback;
}

const cases = [
  ['exact class wins', { className: 'Part', tags: ['Part', 'BasePart', 'PVInstance', 'Instance'] }, 'part'],
  ['MeshPart is not just a Part', { className: 'MeshPart', tags: ['MeshPart', 'BasePart', 'PVInstance', 'Instance'] }, 'mesh'],
  ['ModuleScript', { className: 'ModuleScript', tags: ['ModuleScript', 'LuaSourceContainer', 'Instance'] }, 'modulescript'],
  [
    'disabled beats class',
    { className: 'Script', tags: ['Script', 'BaseScript', 'LuaSourceContainer', 'Instance'], flags: { disabled: true } },
    'script-disabled',
  ],
  [
    'unknown class falls back through its base classes',
    { className: 'SomeClassShippedLastWeek', tags: ['SomeClassShippedLastWeek', 'GuiObject', 'GuiBase', 'Instance'] },
    'frame',
  ],
  [
    'unknown part-like class lands on part',
    { className: 'SomeNewPart', tags: ['SomeNewPart', 'BasePart', 'PVInstance', 'Instance'] },
    'part',
  ],
  ['nothing known at all still resolves', { className: 'Totally', tags: ['Totally', 'Instance'] }, 'instance'],
  [
    'an unmapped service gets the service marker, not the generic dot',
    { className: 'SomeFutureService', tags: ['SomeFutureService', 'Instance'], flags: { service: true } },
    'service',
  ],
  [
    'a non-service with the same unknown shape does not',
    { className: 'SomeFutureThing', tags: ['SomeFutureThing', 'Instance'], flags: { service: false } },
    'instance',
  ],
  ['services get their own glyphs', { className: 'Workspace', tags: ['Workspace', 'Instance'] }, 'workspace'],
  ['constraint-ish UI classes share one glyph', { className: 'UICorner', tags: ['UICorner', 'UIComponent', 'Instance'] }, 'uiconstraint'],
];

let passed = 0;
for (const [name, node, expected] of cases) {
  process.stdout.write(`  ${name} … `);
  assert.strictEqual(glyphFor(node), expected);
  passed += 1;
  console.log('ok');
}

process.stdout.write('  every mapped glyph has an svg … ');
const named = new Set([
  ...Object.values(map.byClass),
  ...Object.values(map.byTag),
  map.fallback,
  map.serviceFallback,
  map.disabledOverlay,
]);
const missing = [...named].filter((glyph) => !fs.existsSync(path.join(MEDIA, 'icons', `${glyph}.svg`)));
assert.deepStrictEqual(missing, [], `missing SVGs: ${missing.join(', ')}`);
passed += 1;
console.log('ok');

process.stdout.write('  every svg is referenced by the map … ');
const onDisk = fs
  .readdirSync(path.join(MEDIA, 'icons'))
  .filter((file) => file.endsWith('.svg'))
  .map((file) => file.replace(/\.svg$/, ''));
const orphans = onDisk.filter((glyph) => !named.has(glyph));
assert.deepStrictEqual(orphans, [], `unreferenced SVGs: ${orphans.join(', ')}`);
passed += 1;
console.log('ok');

console.log(`\n${passed} passed`);
