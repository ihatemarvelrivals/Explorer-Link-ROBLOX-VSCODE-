# Explorer Link — setup

Two halves: a plugin inside Roblox Studio and this extension in VS Code. The extension
listens; the plugin connects to it.

## 1. Install the Studio plugin

Build it (no Rust toolchain needed):

```bash
python3 plugin/build.py --out dist
```

Copy `dist/ExplorerLink.rbxmx` into your Studio plugins folder:

| OS | Folder |
|---|---|
| Windows | `%LOCALAPPDATA%\Roblox\Plugins` |
| macOS | `~/Documents/Roblox/Plugins` |

In Studio: **Plugins ▸ Explorer Link** opens the panel. If you already had Studio open,
restart it so the plugin loads.

If you use Rojo, `rojo build plugin -o ExplorerLink.rbxmx` produces the same file.

## 2. Pair them

1. In VS Code, run **Explorer Link: Show Pairing Token** and copy the token.
2. Paste it into the plugin panel in Studio and press **Save & reconnect**.

The first connection raises Studio's "allow this plugin to access localhost" prompt.
Allow it — it is what lets the plugin reach VS Code at all.

The token is stored per machine on the VS Code side and in your plugin settings on the
Studio side, so this is a one-time step.

## 3. Use it

The **Roblox Explorer** icon in the activity bar holds two views:

* **Explorer** — the live tree. Expanding a node fetches its children; collapsing stops
  watching it. Clicking a script opens its source in a read-only tab.
* **Properties** — the selected instance's properties, grouped the way Studio groups
  them, plus attributes and CollectionService tags.

* **3D Preview** — select a Part, MeshPart or Model and it is drawn below Properties.
  Drag to orbit, shift-drag to pan, scroll to zoom, double-click or **Fit** to reframe.
  Meshes and unions are drawn as their bounding box with an orange outline, and the
  header counts them — a plugin cannot read mesh geometry, so nothing here pretends
  otherwise.

Selection is mirrored both ways by default. Right-click a row for **Reveal in Studio**
and **Copy Path**, and use **Go to Path…** in the view title to jump straight to
something like `game.ReplicatedStorage.Modules.Combat`.

In Properties, **clicking a row copies its value**. Right-click for the property name or
a `Name = value` pair, and use the copy button in the view title for everything at once.

## 4. Turn on Script Sync so you can edit

Everything above is read-only. To actually edit scripts in VS Code, use Roblox's own
[Script Sync](https://create.roblox.com/docs/scripting/sync) — this extension hands off
to it rather than reimplementing it.

In Studio's Explorer, right-click a folder or service (say `ReplicatedStorage`) and pick
**Sync to…**, then choose a folder on disk. Studio writes real files there and keeps them
two-way from then on:

| On disk | In Studio |
|---|---|
| `Combat.luau` | ModuleScript |
| `Main.server.luau` | Script |
| `Hud.client.luau` | Script with RunContext = Client |
| `Legacy.local.luau` | LocalScript |
| `Modules/` | Folder |
| `Combat/init.luau` | a script that has children |

Open that folder in VS Code (**File ▸ Open Folder**). Now clicking a script in the
Explorer tree opens the real file — editable, with the language server and git working
normally. Scripts outside a synced folder still open read-only, as before.

Only Script, LocalScript, ModuleScript and Folder sync. Parts, Models and every other
instance type stay visible in the tree here but have no file.

If a script that should be synced still opens read-only, run **Explorer Link: Rescan for
Synced Files** — the search results are cached, and a folder synced after you connected
will not be noticed until the cache clears.

## 5. Put it on GitHub

Once Script Sync is writing files, the folder is an ordinary directory and git works on
it with nothing special. Run **Explorer Link: Set Up Git in Sync Folder** to write a
Roblox `.gitignore`, initialise the repo, and open the Source Control panel. From there,
**Publish Branch** pushes it to GitHub.

## Troubleshooting

**The plugin panel says "VS Code not listening".** The extension is not running, or the
ports do not match. Check `explorerLink.port` in VS Code settings against the port in
the plugin panel; both default to 34873.

**"Token rejected".** Re-copy it with **Explorer Link: Show Pairing Token** — the token
changes only if VS Code's global storage was cleared.

**The panel says nothing at all and Studio's Output has no `[ExplorerLink]` line.** The
plugin did not load. Check that the `.rbxmx` is in the plugins folder and restart Studio.

**Port already in use.** Another VS Code window has the server. Close it, or give this
window a different `explorerLink.port` and match it in the plugin panel.

**Everything vanishes when you press Play.** Expected — the plugin only holds the link
in edit mode. It comes back when you stop the play test.
