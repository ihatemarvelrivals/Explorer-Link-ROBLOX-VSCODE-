# Roblox Explorer Link

A live mirror of a Roblox Studio place's Explorer inside VS Code — the tree, class
icons, properties, and read-only script source — updating as you work in Studio.

Two halves that talk over loopback HTTP:

```
┌─────────────────────────┐                      ┌──────────────────────────┐
│  Roblox Studio plugin   │   POST /poll         │   VS Code extension      │
│  plugin/  (Luau)        │ ───────────────────► │   extension/  (TS)       │
│                         │      events ▲        │                          │
│  • lazy tree            │    commands ▼        │  • Explorer tree view    │
│  • property reads       │ ◄─────────────────── │  • Properties view       │
│  • geometry reads       │                      │  • 3D preview (WebGL)    │
│  • selection mirror     │                      │  • rbxlink: source docs  │
└─────────────────────────┘                      └──────────────────────────┘
```

## What it does

* **Live tree.** Every service Studio shows, expanded lazily. Add, delete, rename or
  reparent something in Studio and the row updates without a refresh.
* **Class icons.** An original 48-glyph icon set mapped onto ~90 classes with base-class
  fallback, so a class released next month still lands on a sensible icon.
* **Properties, copyable.** Grouped like Studio's Properties window, plus attributes and
  CollectionService tags. Click any row to copy its value; right-click for the name, the
  `Name = value` pair, or a whole group; copy the lot from the view title.
* **3D preview.** Select a Part, MeshPart or Model and see it drawn, orbitable, in a
  panel under Properties — or as a full editor tab via **Open 3D Preview in Editor**. Blocks, spheres, cylinders and wedges are exact; meshes and
  unions are drawn as their real bounding box, outlined and counted, because no plugin
  API can hand over mesh vertices.
* **Scripts, editable.** Click one and it opens the real file on disk if Roblox's
  [Script Sync](https://create.roblox.com/docs/scripting/sync) is writing it — a normal
  editable buffer with the language server, git gutter and all. Not synced? You get a
  read-only mirror of Studio's current text instead.
* **Git status in the tree.** A synced script's row carries its file, so VS Code's own
  decorators colour it: modified scripts stand out in the Explorer tree exactly as they
  do in the file explorer.
* **Selection both ways.** Click here, it selects there; select there, it reveals here.
* **Go to Path.** Jump to `game.ReplicatedStorage.Modules.Combat` without expanding four
  levels by hand.

It reads. It does not write to the DataModel — the only things it changes in Studio are
the selection and which script tab is in front, both only when you ask. Editing is Script
Sync's job, and this hands off to it rather than competing with it.

## Quick start

```bash
git clone <this repo> && cd roblox-explorer-link

# Studio plugin -> dist/ExplorerLink.rbxmx, then copy it to your plugins folder
python3 plugin/build.py --out dist

# VS Code extension
cd extension
npm install
npm run compile
```

Press <kbd>F5</kbd> in the `extension/` folder to launch an Extension Development Host,
or `npm run package` to build a `.vsix` you can install normally.

Then pair the two: run **Explorer Link: Show Pairing Token** in VS Code and paste the
token into the plugin's panel in Studio. Full walkthrough in
[`extension/media/setup.md`](extension/media/setup.md).

## Why it is built this way

**Studio polls; VS Code listens.** Luau has no WebSocket client and a plugin cannot
accept inbound connections, so the plugin has to drive every exchange. One endpoint
(`POST /poll`) carries events up and commands down, and the server holds the request
open for up to 20 seconds when it has nothing to say. Idle cost: about three requests a
minute, against Studio's ~500/minute plugin budget.

**The tree is lazy, in both directions.** The plugin never walks the DataModel. VS Code
asks for a node's children when you expand it, and that same moment is when the plugin
starts listening for changes there. Collapse the node and the listeners go away. A
200,000-instance place costs the same at rest as an empty one.

**Icons are original artwork.** Roblox's Explorer icons are proprietary, and
`StudioService:GetClassIcon` hands back a `rbxasset://` spritesheet a plugin cannot read
pixels out of or send anywhere. So `tools/gen_icons.py` draws a set instead, and the
class→glyph map is generated alongside the SVGs so the two cannot drift.

**Script Sync owns editing; this owns the view.** Roblox ships two-way script syncing
in Studio — right-click in the Explorer, "Sync to…", pick a folder. It is good, it has
conflict resolution and Team Create support, and rebuilding it here would mean a worse
copy that fights the real one. What it has no notion of is a tree, properties, or
anything that is not a Script, LocalScript, ModuleScript or Folder. So the two halves
divide cleanly: Studio writes the files, this shows you the place and opens them.

**Matching instances to files is inference, not an API.** Nothing reports which
instances are synced or where they landed, so `syncPaths.ts` scores candidate files by
how much of an instance's ancestry their directory path reproduces. An ambiguous result
deliberately resolves to nothing and falls back to the read-only view — opening the
wrong file would be worse than opening none.

**The preview draws primitives, not meshes, and says so.** Shape, size, CFrame and
colour are all a plugin can read; `MeshId` is an asset reference that never becomes
vertices. Rather than hide that, meshes and unions render as their true bounding box with
an outline and a count in the header. The renderer itself is ~400 lines of hand-written
WebGL: a webview cannot reach a CDN, and vendoring Three.js to draw five primitives would
cost more than writing the five primitives.

**Pairing is a token, not trust.** The server binds `127.0.0.1` only and rejects any
request without the shared token, compared in constant time. Without that, any process
on your machine — or a web page you happened to open — could drive your Studio session.

Details of the wire format: [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Layout

```
plugin/
  src/
    init.server.lua     entry point; edit-mode only
    Transport.lua       the two HTTP loops, backoff, request budget
    Commands.lua        one handler per command type
    Watcher.lua         subscriptions: what to listen to, and when to stop
    Registry.lua        opaque instance refs
    Serializer.lua      nodes and value formatting
    PropertySpecs.lua   which properties to show, per base class
    ClassTags.lua       curated ancestry for icon fallback
    Ui.lua              toolbar button and dock widget
  build.py              packs src/ into an installable .rbxmx, no Rojo needed
  default.project.json  for those who do use Rojo

extension/
  src/
    extension.ts        wiring: views, commands, status bar
    server.ts           the HTTP server (no vscode import — testable headless)
    tree.ts             Explorer view
    properties.ts       Properties view
    sourceProvider.ts   rbxlink: read-only documents
    icons.ts            class -> glyph resolution
    syncPaths.ts        instance path -> file name, pure and tested
    syncMap.ts          workspace search and cache around syncPaths
    preview.ts          the 3D preview view and its webview host
  media/preview.js      the WebGL renderer; its maths is exported for tests
  test/fake-studio.js   protocol suite + a fake place for UI work without Studio
  test/syncmap.test.js  the instance-path -> file-path matching
  test/preview.test.js  transforms, bounds and primitive meshes
  test/icons.test.js    icon map coverage and fallback order
  media/icons/*.svg     generated

tools/
  gen_icons.py          draws the icon set and its map
  check_lua.py          structural check over the Luau sources
docs/PROTOCOL.md        the wire format
```

## Development

```bash
# extension
cd extension && npm run compile && npm test

# drive the UI without opening Studio at all
TOKEN=<pairing token> node test/fake-studio.js --connect

# plugin
python3 tools/check_lua.py plugin/src
python3 plugin/build.py --out dist

# icons (regenerates SVGs and the class map together)
python3 tools/gen_icons.py --out extension/media
```

`--connect` mode is worth knowing about: it speaks the real protocol with a small fake
place and adds a Part every five seconds, so you can work on the views without a Studio
session in the loop.

## Known limits

* **Editing goes through Script Sync.** The `rbxlink:` mirror is read-only by design;
  edits happen in the real file Studio syncs. A script outside a synced folder can be
  read here but not edited — sync its ancestor in Studio and it becomes editable.
* **The preview is primitives only.** Meshes and unions show as boxes; Roblox exposes no
  way for a plugin to read their geometry. Terrain and particles are not drawn at all.
  It is a shape-and-layout check, not a render of your game.
* **File matching is best-effort.** Two scripts with the same name and no distinguishing
  ancestor folder resolve to nothing rather than to a guess. `Explorer Link: Rescan for
  Synced Files` re-runs the search after you sync something new.
* **Edit mode only.** The plugin drops the link during a play test, so a second copy of
  itself running inside the play session cannot fight the first for the same connection.
* **Properties are a curated list.** Plugins have no reflection API, so `PropertySpecs`
  names the properties worth showing per base class rather than shipping an API dump
  that goes stale. Adding a property is one line in that file.
* **One Studio session at a time.** A second handshake replaces the first. Two places
  side by side need two VS Code windows on different ports.

## Licence

MIT. The icon set in `extension/media/icons/` is original work generated by
`tools/gen_icons.py` and is not derived from Roblox's Explorer icons.
