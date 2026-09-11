#!/usr/bin/env node
/**
 * A Studio stand-in, in two modes.
 *
 *   node test/fake-studio.js            run the protocol test suite (no VS Code needed)
 *   node test/fake-studio.js --connect  connect a fake place to a running extension
 *
 * The second mode is the useful one during development: it gives you a small tree to
 * click around in the sidebar without opening Studio at all. It speaks the same
 * protocol the real plugin does, including the long-poll loop and the lazy children.
 *
 * Run the suite after `npm run compile`.
 */

const assert = require('assert');
const http = require('http');

const { LinkServer } = require('../out/server');

// ---------------------------------------------------------------------------
// a small fake DataModel
// ---------------------------------------------------------------------------

let nextRef = 0;

function inst(className, name, children = []) {
  nextRef += 1;
  return { ref: `i:${nextRef}`, className, name, children, parent: undefined };
}

function buildPlace() {
  const place = [
    inst('Workspace', 'Workspace', [
      inst('Model', 'Sword', [
        inst('Part', 'Handle', [inst('Sound', 'Swing'), inst('Attachment', 'TipAttachment')]),
        inst('Script', 'Attack'),
      ]),
      inst('SpawnLocation', 'SpawnLocation'),
      inst('Terrain', 'Terrain'),
    ]),
    inst('ReplicatedStorage', 'ReplicatedStorage', [
      inst('Folder', 'Modules', [inst('ModuleScript', 'Combat'), inst('ModuleScript', 'Inventory')]),
      inst('RemoteEvent', 'DamageEvent'),
    ]),
    inst('ServerScriptService', 'ServerScriptService', [inst('Script', 'Main')]),
    inst('StarterGui', 'StarterGui', [
      inst('ScreenGui', 'HUD', [inst('Frame', 'Root', [inst('TextLabel', 'Health')])]),
    ]),
  ];

  const byRef = new Map();
  const walk = (node, parent) => {
    node.parent = parent;
    byRef.set(node.ref, node);
    node.children.forEach((child) => walk(child, node));
  };
  place.forEach((node) => walk(node, undefined));
  return { roots: place, byRef };
}

const TAGS = {
  Part: ['Part', 'BasePart', 'PVInstance', 'Instance'],
  Model: ['Model', 'PVInstance', 'Instance'],
  Script: ['Script', 'BaseScript', 'LuaSourceContainer', 'Instance'],
  ModuleScript: ['ModuleScript', 'LuaSourceContainer', 'Instance'],
  Folder: ['Folder', 'Instance'],
  RemoteEvent: ['RemoteEvent', 'Instance'],
  ScreenGui: ['ScreenGui', 'LayerCollector', 'GuiBase', 'Instance'],
  Frame: ['Frame', 'GuiObject', 'GuiBase', 'Instance'],
  TextLabel: ['TextLabel', 'GuiLabel', 'GuiObject', 'GuiBase', 'Instance'],
};

function pathOf(node) {
  const segments = [];
  for (let current = node; current; current = current.parent) {
    segments.unshift(current.name);
  }
  return `game.${segments.join('.')}`;
}

function toNode(node) {
  return {
    ref: node.ref,
    name: node.name,
    className: node.className,
    path: pathOf(node),
    tags: TAGS[node.className] ?? [node.className, 'Instance'],
    childCount: node.children.length,
    flags: {
      script: ['Script', 'LocalScript', 'ModuleScript'].includes(node.className),
      disabled: false,
      service: node.parent === undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// the client half
// ---------------------------------------------------------------------------

class FakePlugin {
  constructor(port, token) {
    this.port = port;
    this.token = token;
    this.sessionId = undefined;
    this.place = buildPlace();
    this.outbox = [];
    this.running = false;
    this.seen = [];
  }

  request(path, body, headers = {}) {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'X-Rel-Token': this.token,
            ...(this.sessionId ? { 'X-Rel-Session': this.sessionId } : {}),
            ...headers,
          },
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: response.statusCode, body: text ? JSON.parse(text) : undefined });
          });
        },
      );
      request.on('error', reject);
      request.end(payload);
    });
  }

  async hello() {
    const result = await this.request('/hello', {
      protocol: 1,
      pluginVersion: '1.0.0',
      placeName: 'Fake Place',
      placeId: 1234,
      studioVersion: '0.700.0-fake',
      isEditMode: true,
    });
    if (result.status !== 200) {
      return result;
    }
    this.sessionId = result.body.sessionId;
    this.outbox.push({ type: 'roots', nodes: this.place.roots.map(toNode) });
    return result;
  }

  handle(command) {
    const node = command.ref ? this.place.byRef.get(command.ref) : undefined;
    this.seen.push(command.type);

    switch (command.type) {
      case 'ping':
        return { ok: true, data: { t: Date.now() } };
      case 'getChildren':
        if (!node) return { ok: false, error: 'stale-ref' };
        return { ok: true, data: { nodes: node.children.map(toNode) } };
      case 'getProperties':
        if (!node) return { ok: false, error: 'stale-ref' };
        return {
          ok: true,
          data: {
            groups: [
              {
                name: 'Instance',
                rows: [
                  { key: 'Name', value: node.name, kind: 'string' },
                  { key: 'ClassName', value: node.className, kind: 'class' },
                ],
              },
            ],
          },
        };
      case 'getGeometry': {
        if (!node) return { ok: false, error: 'stale-ref' };
        const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
        const collect = [];
        const walk = (current) => {
          if (['Part', 'MeshPart', 'SpawnLocation', 'Terrain'].includes(current.className)) {
            collect.push({
              name: current.name,
              className: current.className,
              shape: current.className === 'MeshPart' ? 'box' : 'box',
              approximate: current.className === 'MeshPart',
              size: [4, 1, 2],
              cframe: [collect.length * 5, 0.5, 0, ...identity],
              color: [0.6, 0.6, 0.65],
              transparency: 0,
              material: 'Plastic',
            });
          }
          current.children.forEach(walk);
        };
        walk(node);
        return {
          ok: true,
          data: {
            name: node.name,
            className: node.className,
            path: pathOf(node),
            parts: collect,
            approximated: collect.filter((part) => part.approximate).length,
            truncated: false,
            maxParts: 400,
          },
        };
      }
      case 'getSource':
        if (!node) return { ok: false, error: 'stale-ref' };
        return {
          ok: true,
          data: {
            source: `-- ${node.name}.${node.className}\nprint("hello from ${node.name}")\n`,
            name: node.name,
            className: node.className,
            path: pathOf(node),
          },
        };
      case 'resolvePath': {
        const segments = String(command.path).split('.').filter((s) => s && s !== 'game');
        let current = this.place.roots.find((root) => root.name === segments[0]);
        for (const segment of segments.slice(1)) {
          current = current?.children.find((child) => child.name === segment);
        }
        return { ok: true, data: { ref: current ? current.ref : null } };
      }
      case 'subscribe':
      case 'unsubscribe':
      case 'select':
      case 'revealInStudio':
      case 'releaseSource':
        return { ok: true, data: {} };
      default:
        return { ok: false, error: `unknown-command:${command.type}` };
    }
  }

  /** Mirrors the plugin's two loops: one holding a poll, one flushing events. */
  start() {
    this.running = true;

    const pollLoop = async () => {
      while (this.running) {
        try {
          const result = await this.request('/poll', { events: [], want: true });
          if (result.status === 409) {
            this.sessionId = undefined;
            await this.hello();
            continue;
          }
          for (const command of result.body?.commands ?? []) {
            const answer = this.handle(command);
            this.outbox.push({ type: 'result', id: command.id, ...answer });
          }
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    };

    const flushLoop = async () => {
      while (this.running) {
        if (this.outbox.length > 0 && this.sessionId) {
          const events = this.outbox.splice(0);
          try {
            await this.request('/poll', { events, want: false });
          } catch {
            /* the suite asserts on outcomes, not on transport hiccups */
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    void pollLoop();
    void flushLoop();
  }

  async stop() {
    this.running = false;
    if (this.sessionId) {
      await this.request('/poll', { events: [{ type: 'bye', reason: 'test-over' }], want: false }).catch(
        () => undefined,
      );
    }
  }

  /** Simulates someone dragging a new Part into the Sword model. */
  addPart(parentName, name) {
    const parent = [...this.place.byRef.values()].find((node) => node.name === parentName);
    const child = inst('Part', name);
    child.parent = parent;
    parent.children.push(child);
    this.place.byRef.set(child.ref, child);
    this.outbox.push({
      type: 'childAdded',
      parent: parent.ref,
      node: toNode(child),
      index: parent.children.length,
    });
    return child;
  }
}

// ---------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------

const waitFor = async (predicate, label, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
};

let passed = 0;
async function test(name, body) {
  process.stdout.write(`  ${name} … `);
  await body();
  passed += 1;
  console.log('ok');
}

async function main() {
  if (process.argv.includes('--connect')) {
    return connectMode();
  }

  console.log('protocol suite\n');

  const server = new LinkServer(undefined, 0, 1500);
  const events = [];
  let connectedSessions = 0;
  let disconnects = [];
  server.on('event', (event) => events.push(event));
  server.on('connected', () => (connectedSessions += 1));
  server.on('disconnected', (reason) => disconnects.push(reason));

  const port = await server.start();
  const plugin = new FakePlugin(port, server.token);

  await test('rejects a wrong token with 401', async () => {
    const wrong = new FakePlugin(port, 'not-the-token');
    const result = await wrong.hello();
    assert.strictEqual(result.status, 401);
  });

  await test('rejects a protocol mismatch', async () => {
    const result = await plugin.request('/hello', { protocol: 999, pluginVersion: 'x' });
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.error, 'protocol-mismatch');
  });

  await test('handshake issues a session', async () => {
    const result = await plugin.hello();
    assert.strictEqual(result.status, 200);
    assert.ok(result.body.sessionId);
    assert.strictEqual(result.body.protocol, 1);
    assert.strictEqual(connectedSessions, 1);
    assert.strictEqual(server.isConnected, true);
  });

  await test('rejects an unknown session with 409', async () => {
    const stale = new FakePlugin(port, server.token);
    stale.sessionId = 'nope';
    const result = await stale.request('/poll', { events: [], want: false });
    assert.strictEqual(result.status, 409);
  });

  plugin.start();

  await test('delivers the roots event', async () => {
    await waitFor(() => events.some((event) => event.type === 'roots'), 'roots event');
    const roots = events.find((event) => event.type === 'roots');
    assert.strictEqual(roots.nodes.length, 4);
    assert.strictEqual(roots.nodes[0].name, 'Workspace');
    assert.deepStrictEqual(roots.nodes[0].flags.service, true);
  });

  let handleRef;

  await test('getChildren round-trips lazily', async () => {
    const roots = events.find((event) => event.type === 'roots');
    const workspace = roots.nodes[0];
    const level1 = await server.send('getChildren', { ref: workspace.ref });
    assert.strictEqual(level1.nodes.length, 3);

    const sword = level1.nodes.find((node) => node.name === 'Sword');
    const level2 = await server.send('getChildren', { ref: sword.ref });
    assert.deepStrictEqual(
      level2.nodes.map((node) => node.name),
      ['Handle', 'Attack'],
    );
    handleRef = level2.nodes[0].ref;
    assert.strictEqual(level2.nodes[1].flags.script, true);
    assert.strictEqual(level2.nodes[0].path, 'game.Workspace.Sword.Handle');
  });

  await test('a held poll answers in well under its hold window', async () => {
    // The point of the long poll: latency is a round trip, not the hold duration.
    const started = Date.now();
    await server.send('ping');
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, `ping took ${elapsed}ms`);
  });

  await test('a failing command rejects with the error the plugin reported', async () => {
    await assert.rejects(() => server.send('getChildren', { ref: 'i:99999' }), /stale-ref/);
  });

  await test('an unknown command type is reported, not silently dropped', async () => {
    await assert.rejects(() => server.send('nonsense'), /unknown-command/);
  });

  await test('getSource returns script text', async () => {
    const roots = events.find((event) => event.type === 'roots');
    const rs = roots.nodes.find((node) => node.name === 'ReplicatedStorage');
    const modules = await server.send('getChildren', { ref: rs.ref });
    const folder = modules.nodes.find((node) => node.name === 'Modules');
    const inside = await server.send('getChildren', { ref: folder.ref });
    const combat = inside.nodes.find((node) => node.name === 'Combat');
    const source = await server.send('getSource', { ref: combat.ref });
    assert.match(source.source, /hello from Combat/);
    assert.strictEqual(source.path, 'game.ReplicatedStorage.Modules.Combat');
  });

  await test('unsolicited events reach the extension', async () => {
    const before = events.length;
    plugin.addPart('Sword', 'Blade');
    await waitFor(() => events.length > before, 'childAdded event');
    const added = events.slice(before).find((event) => event.type === 'childAdded');
    assert.ok(added, 'expected a childAdded event');
    assert.strictEqual(added.node.name, 'Blade');
    assert.strictEqual(added.node.className, 'Part');
  });

  await test('geometry round-trips and bounds compute from it', async () => {
    const roots = events.find((event) => event.type === 'roots');
    const workspace = roots.nodes[0];
    const geometry = await server.send('getGeometry', { ref: workspace.ref, maxParts: 400 });
    assert.ok(geometry.parts.length >= 3, 'expected the fake Workspace to hold parts');
    assert.strictEqual(typeof geometry.approximated, 'number');

    // The renderer's own bounds maths has to accept what the wire actually delivers.
    const bounds = require('../media/preview.js').computeBounds(geometry.parts);
    assert.ok(Number.isFinite(bounds.radius) && bounds.radius > 0);
    assert.strictEqual(bounds.center.length, 3);
  });

  await test('properties come back grouped', async () => {
    const result = await server.send('getProperties', { ref: handleRef });
    assert.strictEqual(result.groups[0].name, 'Instance');
    assert.strictEqual(result.groups[0].rows[0].value, 'Handle');
  });

  await test('a second handshake replaces the first session', async () => {
    // Park the first client's loops: it re-handshakes on 409 exactly like the real
    // plugin, which would keep resurrecting the session the tests below want gone.
    plugin.running = false;
    await new Promise((resolve) => setTimeout(resolve, 100));
    disconnects = [];
    const second = new FakePlugin(port, server.token);
    await second.hello();
    assert.strictEqual(connectedSessions, 2);
    assert.deepStrictEqual(disconnects, ['replaced']);
    // The original client's session id is now stale.
    const result = await plugin.request('/poll', { events: [], want: false });
    assert.strictEqual(result.status, 409);
    await second.stop();
  });

  await test('bye disconnects the session', async () => {
    disconnects = [];
    const third = new FakePlugin(port, server.token);
    await third.hello();
    await third.request('/poll', { events: [{ type: 'bye', reason: 'plugin-unloading' }], want: false });
    assert.deepStrictEqual(disconnects, ['plugin-unloading']);
    assert.strictEqual(server.isConnected, false);
  });

  await test('commands rejected while disconnected', async () => {
    await assert.rejects(() => server.send('ping'), /not-connected/);
  });

  await test('a silent plugin is eventually declared gone', async () => {
    disconnects = [];
    const quiet = new FakePlugin(port, server.token);
    await quiet.hello();
    assert.strictEqual(server.isConnected, true);
    // holdMs is 1500 in this suite, and liveness allows holdMs + slack.
    await waitFor(() => disconnects.includes('timeout'), 'liveness timeout', 25_000);
    assert.strictEqual(server.isConnected, false);
  });

  await plugin.stop();
  await server.stop();

  console.log(`\n${passed} passed`);
}

/** Keeps a fake place attached to a running extension, for UI work without Studio. */
async function connectMode() {
  const port = Number(process.env.PORT ?? 34873);
  const token = process.env.TOKEN;
  if (!token) {
    console.error('set TOKEN to the pairing token from the VS Code status bar');
    process.exit(1);
  }

  const plugin = new FakePlugin(port, token);
  const result = await plugin.hello();
  if (result.status !== 200) {
    console.error(`handshake failed: ${result.status} ${JSON.stringify(result.body)}`);
    process.exit(1);
  }
  plugin.start();
  console.log(`fake place connected on port ${port}. Ctrl-C to stop.`);

  // Add a part every 5 seconds so live updates are visible in the sidebar.
  let counter = 0;
  setInterval(() => {
    counter += 1;
    plugin.addPart('Sword', `Part${counter}`);
    console.log(`added Part${counter} to Sword`);
  }, 5000);

  process.on('SIGINT', async () => {
    await plugin.stop();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('\nFAILED:', error.message);
  process.exit(1);
});
