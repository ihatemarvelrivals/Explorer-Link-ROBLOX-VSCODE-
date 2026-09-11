# Explorer Link protocol v1

A minimal, one-endpoint protocol between the **Roblox Studio plugin** (client) and the
**VS Code extension** (server).

## Why this shape

Luau in Studio has no WebSocket client and cannot listen for inbound connections, so the
plugin must drive every exchange. `HttpService` in a plugin is also rate-limited
(~500 requests/minute per Studio session) and blocks ports below 1024 except 80/443.

So: **VS Code hosts an HTTP server on `127.0.0.1` and the plugin long-polls it.** One
endpoint, `POST /poll`, carries plugin→VS Code *events* in the request body and
VS Code→plugin *commands* in the response body. Idle cost is ~3 requests/minute.

```
┌──────────────────┐   POST /poll  {events:[…]}   ┌─────────────────────┐
│  Studio plugin   │ ───────────────────────────► │  VS Code extension  │
│  (Luau, client)  │ ◄─────────────────────────── │  (HTTP server)      │
└──────────────────┘   200        {commands:[…]}  └─────────────────────┘
        held open up to `holdMs` when there is nothing to send either way
```

The tree is **lazy**. The plugin never walks the whole DataModel; VS Code asks for a
node's children when the user expands it, which is also when the plugin starts watching
that node for changes. A 200k-instance place costs the same at rest as an empty one.

## Transport rules

* Base URL `http://localhost:<port>` — default port **34873**.
  Use the hostname `localhost`, not `127.0.0.1`: Studio's trust check rejects the
  literal IP for plugin requests.
* All bodies are JSON, `Content-Type: application/json`.
* Every request carries `X-Rel-Token`, a shared secret the extension generates per
  session and shows in its status bar. Requests without the right token get `401`.
  This keeps other local processes (and web pages) from driving your Studio session.
* The server sends `Access-Control-Allow-Origin: null` and never enables CORS for real
  origins, so a browser page cannot reach it even with the token.

## Handshake

```http
POST /hello
{ "protocol": 1, "pluginVersion": "1.0.0", "placeName": "Baseplate",
  "placeId": 0, "studioVersion": "0.700.0", "isEditMode": true }
```
```json
{ "ok": true, "sessionId": "b1f0…", "serverVersion": "1.0.0",
  "holdMs": 20000, "protocol": 1 }
```

`sessionId` must be echoed on every later request as `X-Rel-Session`. If the extension
restarts it returns `409 {"reason":"unknown-session"}` to any stale session and the
plugin re-handshakes. Re-handshaking resets all subscriptions.

## The poll loop

```http
POST /poll
{ "events": [ … ], "want": true }
```
```json
{ "commands": [ … ] }
```

* `want: true` means "hold the connection open if you have nothing for me". The server
  holds up to `holdMs` (default 20s), returning early the moment a command is queued.
* When the plugin has events to deliver it sends them with `want: false`; the server
  responds immediately with whatever commands it has (possibly none), and the plugin
  loops straight back into a `want: true` poll.
* The plugin coalesces events on a 250 ms debounce, so a burst of DataModel churn is one
  request, not one per change.

## Commands (VS Code → plugin)

Every command has `id` (monotonic integer) and `type`. The plugin answers with a
`result` event carrying the same `id`.

| type | payload | result |
|---|---|---|
| `getChildren` | `{ ref }` | `{ nodes: Node[] }` |
| `getProperties` | `{ ref }` | `{ groups: PropertyGroup[] }` |
| `getSource` | `{ ref }` | `{ source, name, className, path }` |
| `subscribe` | `{ refs: string[] }` | `{}` |
| `unsubscribe` | `{ refs: string[] }` | `{}` |
| `select` | `{ refs: string[] }` | `{}` |
| `revealInStudio` | `{ ref }` | `{}` |
| `getGeometry` | `{ ref, maxParts }` | `{ parts: GeometryPart[], approximated, truncated, … }` |
| `resolvePath` | `{ path: string }` | `{ ref }` or `{ ref: null }` |
| `ping` | `{}` | `{ t }` |

`ref` is an opaque string the plugin mints per instance (`"i:42"`). Refs are stable for
the life of a session and are invalidated when the instance is destroyed.

`getSource` reads through `ScriptEditorService:GetEditorSource`, not the `Source`
property. Roblox decoupled the two: while a script is open in Studio's editor, `Source`
catches up only periodically, so reading it directly can return text the user edited
minutes ago. `Source` remains the fallback on Studio builds without the newer API.

## Events (plugin → VS Code)

| type | payload |
|---|---|
| `result` | `{ id, ok, data }` or `{ id, ok: false, error }` |
| `roots` | `{ nodes: Node[] }` — sent right after the handshake |
| `childAdded` | `{ parent, node, index }` |
| `childRemoved` | `{ parent, ref }` |
| `nodeChanged` | `{ node }` — name/class/flags changed |
| `selectionChanged` | `{ refs: string[] }` |
| `sourceChanged` | `{ ref }` — a watched script's Source changed |
| `placeChanged` | `{ placeName, placeId }` |
| `bye` | `{ reason }` — plugin shutting down or place closing |

## Node

```json
{
  "ref": "i:42",
  "name": "Handle",
  "className": "MeshPart",
  "path": "game.Workspace.Sword.Handle",
  "tags": ["MeshPart", "BasePart", "PVInstance", "Instance"],
  "childCount": 3,
  "flags": { "script": false, "disabled": false, "service": false }
}
```

`tags` is the instance's ancestry filtered to a curated list of ~40 base classes the
extension knows icons for. The extension picks an icon by exact `className` first, then
walks `tags` in order, then falls back to a generic instance icon. That means a class
Roblox shipped last week still gets a sensible icon without an API dump.

`childCount` lets the tree render a twisty without fetching children.

## PropertyGroup

```json
{ "name": "Part",
  "rows": [ { "key": "Anchored", "value": "false", "kind": "bool" },
            { "key": "Size", "value": "4, 1, 2", "kind": "Vector3" } ] }
```

Values are pre-formatted strings — the extension only displays them. `kind` drives the
value's colour in the properties view. A group named `Attributes` is appended when the
instance has any.

## GeometryPart

```json
{ "name": "Handle", "className": "MeshPart", "shape": "box", "approximate": true,
  "size": [4, 1, 2], "cframe": [0, 5, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  "color": [0.6, 0.6, 0.65], "transparency": 0, "material": "Plastic" }
```

`shape` is one of `box`, `ball`, `cylinder`, `wedge`, `cornerwedge`. `cframe` is
`CFrame:GetComponents()` order — position, then the rotation matrix row by row.

`approximate` is true when the shape is a stand-in. A plugin cannot read the vertices
behind a MeshPart or a union (`MeshId` is an asset reference, not data), so those report
as boxes, and `approximated` counts them so the viewer can say so rather than quietly
drawing something untrue.

The walk is bounded twice over: it stops after `maxParts` parts or 25,000 visited
instances, setting `truncated`. A preview of a 50,000-part map is not worth the payload.

## Errors

| status | meaning |
|---|---|
| `401` | bad or missing `X-Rel-Token` |
| `409` | unknown/stale `X-Rel-Session`; re-handshake |
| `429` | server is shedding load; plugin backs off to 2 s |
| `503` | server shutting down; plugin backs off to 5 s and retries `/hello` |

The plugin treats any transport failure as "VS Code isn't running": it backs off
(1 s → 2 s → 5 s → 10 s, capped) and keeps retrying `/hello` quietly, so the order you
start Studio and VS Code in never matters.
