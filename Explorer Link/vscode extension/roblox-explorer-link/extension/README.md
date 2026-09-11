# Roblox Explorer Link

A live mirror of a Roblox Studio place's Explorer inside VS Code — the tree, class
icons, properties, and read-only script source — updating as you work in Studio.

Needs the companion Studio plugin. Build it with `python3 plugin/build.py --out dist`
and drop the resulting `ExplorerLink.rbxmx` into your Studio plugins folder.

## Getting connected

1. Run **Explorer Link: Show Pairing Token** here and copy the token.
2. In Studio, open **Plugins ▸ Explorer Link**, paste the token, press **Save & reconnect**.
3. Allow the "plugin wants to access localhost" prompt Studio raises.

The **Roblox Explorer** icon in the activity bar holds three panels:

* **Explorer** — the live tree. Expanding a node fetches its children.
* **Properties** — grouped like Studio's, plus attributes and tags. **Click a row to
  copy its value**; right-click for the name, the `Name = value` pair, or the whole
  group; the title bar copies everything.
* **3D Preview** — select a Part, MeshPart or Model and it is drawn here. Drag to orbit,
  shift-drag to pan, scroll to zoom, double-click to fit.

If the 3D Preview panel does not appear in the sidebar, run **Explorer Link: Open 3D
Preview in Editor** — the same renderer in an editor tab, with more room, and not
dependent on the sidebar view registering.

Meshes and unions appear as their true bounding box with an orange outline and a count
in the header: `MeshId` is an asset reference, and no plugin API turns it into geometry,
so the preview shows the honest approximation rather than pretending.

## Editing, and GitHub

Editing runs through Roblox's own [Script Sync](https://create.roblox.com/docs/scripting/sync),
not through this extension. In Studio, right-click a folder in the Explorer, choose
**Sync to…**, pick a directory, then open that directory in VS Code.

Clicking a script in the tree now opens the **real file** — editable, language server
attached, git tracking it — and its row picks up git decoration colours. Anything not
synced falls back to a read-only mirror of Studio's current text.

For GitHub, run **Explorer Link: Set Up Git in Sync Folder**: it writes a Roblox
`.gitignore`, initialises the repo and opens Source Control, where **Publish Branch**
does the rest.

Full walkthrough: [media/setup.md](media/setup.md). Protocol: `docs/PROTOCOL.md` in the
repo root.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `explorerLink.port` | 34873 | Port the link server listens on; must match the plugin panel |
| `explorerLink.preferDiskFiles` | true | Open the Script Sync file when one exists, instead of the read-only copy |
| `explorerLink.showClassNames` | true | Show ClassName beside each name |
| `explorerLink.followStudioSelection` | true | Reveal here what you select in Studio |
| `explorerLink.syncSelectionToStudio` | true | Select in Studio what you click here |
| `explorerLink.openScriptOnClick` | true | Single click opens a script's source |
| `explorerLink.holdMs` | 20000 | How long a poll is held open when idle |

It never writes to the DataModel. The only things it changes in Studio are the selection
and which script tab is in front, and only when you ask.
