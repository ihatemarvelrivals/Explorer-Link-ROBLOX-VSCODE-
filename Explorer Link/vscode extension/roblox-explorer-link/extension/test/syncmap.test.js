#!/usr/bin/env node
/**
 * Tests the instance-path → file-path matching that backs "open the synced file".
 *
 * This is the piece most able to be quietly wrong: a bad match means clicking one script
 * and editing a different one. So the cases below lean on the two things that matter —
 * that a confident match is found where a person would find one, and that an ambiguous
 * one resolves to nothing rather than to a guess.
 *
 * Run after `npm run compile`.
 */

const assert = require('assert');

const { ancestorsOf, candidatesFor, pickBest, scoreCandidate } = require('../out/syncPaths');

let passed = 0;
function test(name, body) {
  process.stdout.write(`  ${name} … `);
  body();
  passed += 1;
  console.log('ok');
}

/** Builds the {filePath, candidate} list the way SyncMap does, from a file listing. */
function scored(name, className, hasChildren, paths) {
  const candidates = candidatesFor(name, className, hasChildren);
  const out = [];
  for (const candidate of candidates) {
    const wanted = candidate.fileName.split('/').pop();
    const wantedDir = candidate.isInit ? candidate.fileName.split('/')[0] : undefined;
    for (const filePath of paths) {
      const segments = filePath.split('/');
      const base = segments[segments.length - 1];
      const dir = segments[segments.length - 2];
      if (base !== wanted) {
        continue;
      }
      if (candidate.isInit && dir !== wantedDir) {
        continue;
      }
      if (!candidate.isInit && base.startsWith('init.')) {
        continue;
      }
      out.push({ filePath, candidate });
    }
  }
  return out;
}

// -- naming conventions -----------------------------------------------------

test('ModuleScript looks for a bare .luau first', () => {
  const names = candidatesFor('Combat', 'ModuleScript', false).map((c) => c.fileName);
  assert.deepStrictEqual(names, ['Combat.luau', 'Combat.lua']);
});

test('Script looks for .server before .client', () => {
  const names = candidatesFor('Main', 'Script', false).map((c) => c.fileName);
  assert.deepStrictEqual(names, ['Main.server.luau', 'Main.server.lua', 'Main.client.luau', 'Main.client.lua']);
});

test('LocalScript accepts both .local and Rojo-style .client', () => {
  const names = candidatesFor('Hud', 'LocalScript', false).map((c) => c.fileName);
  assert.ok(names.includes('Hud.local.luau'));
  assert.ok(names.includes('Hud.client.luau'));
});

test('only a script with children looks for an init file', () => {
  const without = candidatesFor('Combat', 'ModuleScript', false).map((c) => c.fileName);
  const with_ = candidatesFor('Combat', 'ModuleScript', true).map((c) => c.fileName);
  assert.ok(!without.some((n) => n.includes('init')));
  assert.ok(with_.includes('Combat/init.luau'));
});

// -- path scoring -----------------------------------------------------------

test('ancestorsOf drops game and the script itself', () => {
  assert.deepStrictEqual(ancestorsOf('game.ReplicatedStorage.Modules.Combat'), [
    'ReplicatedStorage',
    'Modules',
  ]);
});

test('score counts matching ancestor directories from the file up', () => {
  const ancestors = ['ReplicatedStorage', 'Modules', 'Weapons'];
  assert.strictEqual(scoreCandidate(ancestors, '/r/src/Modules/Weapons/Sword.luau', 'Sword', false), 2);
  assert.strictEqual(scoreCandidate(ancestors, '/r/src/Weapons/Sword.luau', 'Sword', false), 1);
  assert.strictEqual(scoreCandidate(ancestors, '/r/anywhere/Sword.luau', 'Sword', false), 0);
});

test('an init file must sit in a directory named for the script', () => {
  const ancestors = ['ReplicatedStorage', 'Modules'];
  assert.strictEqual(scoreCandidate(ancestors, '/r/Modules/Combat/init.luau', 'Combat', true), 1);
  // Same file, wrong owning directory: not this script at all.
  assert.strictEqual(scoreCandidate(ancestors, '/r/Modules/Other/init.luau', 'Combat', true), -1);
});

test('case differences do not break a match', () => {
  // Windows and macOS are case-insensitive by default; a case difference is not evidence.
  assert.strictEqual(scoreCandidate(['ReplicatedStorage'], '/r/replicatedstorage/A.luau', 'A', false), 1);
});

// -- picking ----------------------------------------------------------------

test('picks the file whose folders reproduce the instance path', () => {
  const files = scored('Combat', 'ModuleScript', false, [
    '/repo/src/Modules/Combat.luau',
    '/repo/legacy/Combat.luau',
  ]);
  assert.strictEqual(
    pickBest(ancestorsOf('game.ReplicatedStorage.Modules.Combat'), 'Combat', files),
    '/repo/src/Modules/Combat.luau',
  );
});

test('a single unanchored candidate is still accepted', () => {
  // One file named Combat.luau anywhere in the workspace is almost certainly the one,
  // even if no parent folder corroborates it.
  const files = scored('Combat', 'ModuleScript', false, ['/repo/whatever/Combat.luau']);
  assert.strictEqual(
    pickBest(ancestorsOf('game.ReplicatedStorage.Modules.Combat'), 'Combat', files),
    '/repo/whatever/Combat.luau',
  );
});

test('two equally unanchored candidates resolve to nothing, not a coin flip', () => {
  const files = scored('Combat', 'ModuleScript', false, [
    '/repo/alpha/Combat.luau',
    '/repo/beta/Combat.luau',
  ]);
  assert.strictEqual(pickBest(ancestorsOf('game.ReplicatedStorage.Combat'), 'Combat', files), undefined);
});

test('an anchored candidate beats unanchored ones', () => {
  const files = scored('Combat', 'ModuleScript', false, [
    '/repo/alpha/Combat.luau',
    '/repo/beta/Combat.luau',
    '/repo/src/Modules/Combat.luau',
  ]);
  assert.strictEqual(
    pickBest(ancestorsOf('game.ReplicatedStorage.Modules.Combat'), 'Combat', files),
    '/repo/src/Modules/Combat.luau',
  );
});

test('.luau wins over .lua at equal depth', () => {
  const files = scored('Combat', 'ModuleScript', false, [
    '/repo/Modules/Combat.lua',
    '/repo/Modules/Combat.luau',
  ]);
  assert.strictEqual(
    pickBest(ancestorsOf('game.ReplicatedStorage.Modules.Combat'), 'Combat', files),
    '/repo/Modules/Combat.luau',
  );
});

test('a Script prefers .server.luau over .client.luau', () => {
  const files = scored('Main', 'Script', false, [
    '/repo/ServerScriptService/Main.client.luau',
    '/repo/ServerScriptService/Main.server.luau',
  ]);
  assert.strictEqual(
    pickBest(ancestorsOf('game.ServerScriptService.Main'), 'Main', files),
    '/repo/ServerScriptService/Main.server.luau',
  );
});

test('a script with children resolves to its init file', () => {
  const files = scored('Combat', 'ModuleScript', true, [
    '/repo/src/Modules/Combat/init.luau',
    '/repo/src/Modules/Combat/Helpers.luau',
  ]);
  assert.strictEqual(
    pickBest(ancestorsOf('game.ReplicatedStorage.Modules.Combat'), 'Combat', files),
    '/repo/src/Modules/Combat/init.luau',
  );
});

test('nothing on disk resolves to nothing', () => {
  assert.strictEqual(pickBest(['ReplicatedStorage'], 'Combat', []), undefined);
});

test('two scripts with the same name in different folders do not cross over', () => {
  // The realistic failure mode: Modules/Util and Shared/Util both exist.
  const files = scored('Util', 'ModuleScript', false, [
    '/repo/src/Modules/Util.luau',
    '/repo/src/Shared/Util.luau',
  ]);
  assert.strictEqual(
    pickBest(ancestorsOf('game.ReplicatedStorage.Shared.Util'), 'Util', files),
    '/repo/src/Shared/Util.luau',
  );
  assert.strictEqual(
    pickBest(ancestorsOf('game.ReplicatedStorage.Modules.Util'), 'Util', files),
    '/repo/src/Modules/Util.luau',
  );
});

console.log(`\n${passed} passed`);
