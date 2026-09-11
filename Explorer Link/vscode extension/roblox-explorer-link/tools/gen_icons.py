#!/usr/bin/env python3
"""Generate the Explorer Link icon set.

Roblox's own Explorer icons are proprietary artwork, so this ships an original set
instead: ~45 hand-specified glyphs at 16x16, plus a map from class names and base-class
tags onto them.

The colours are deliberately mid-luminance so one file reads correctly against both a
light and a dark VS Code theme — TreeItem SVG icons are not recoloured by the theme the
way codicons are, so each icon has to work in both on its own.

    python3 tools/gen_icons.py [--out extension/media]

Writes <out>/icons/<glyph>.svg and <out>/icon-map.json.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

# ---------------------------------------------------------------------------
# palette
# ---------------------------------------------------------------------------

C = {
    "part": "#9BA6B2",
    "partEdge": "#6E7A88",
    "mesh": "#7FA8C9",
    "model": "#8D97A3",
    "folder": "#D9A441",
    "script": "#5CA35C",
    "local": "#4E8FD6",
    "module": "#C7913F",
    "ui": "#A379DA",
    "uiSoft": "#C7B0EC",
    "remote": "#E0736B",
    "value": "#4FB3BF",
    "physics": "#D2934F",
    "light": "#E3C069",
    "sound": "#C176D8",
    "fx": "#E08AB0",
    "service": "#79838F",
    "camera": "#6D8CA8",
    "humanoid": "#6FB58A",
    "ink": "#4A5058",
    "paper": "#E8ECF1",
}

HEAD = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" '
    'fill="none" shape-rendering="geometricPrecision">'
)
TAIL = "</svg>"


# ---------------------------------------------------------------------------
# glyph primitives
# ---------------------------------------------------------------------------


def iso_cube(top: str, left: str, right: str, edge: str | None = None) -> str:
    """A three-face isometric box — the shape almost everything spatial builds on."""
    parts = [
        f'<path d="M8 1.6 14 4.9 8 8.2 2 4.9Z" fill="{top}"/>',
        f'<path d="M2 4.9 8 8.2v6.2l-6-3.3Z" fill="{left}"/>',
        f'<path d="M14 4.9 8 8.2v6.2l6-3.3Z" fill="{right}"/>',
    ]
    if edge:
        parts.append(
            f'<path d="M8 1.6 14 4.9v6.2l-6 3.3-6-3.3V4.9Z" stroke="{edge}" '
            'stroke-width="0.9" stroke-linejoin="round" fill="none"/>'
        )
    return "".join(parts)


def shade(hex_color: str, factor: float) -> str:
    r = int(hex_color[1:3], 16)
    g = int(hex_color[3:5], 16)
    b = int(hex_color[5:7], 16)
    f = lambda v: max(0, min(255, round(v * factor)))
    return f"#{f(r):02X}{f(g):02X}{f(b):02X}"


def cube(color: str) -> str:
    return iso_cube(shade(color, 1.18), shade(color, 0.72), shade(color, 0.92), shade(color, 0.6))


def page(accent: str, lines: int = 3, mark: str = "") -> str:
    """A document with a folded corner, a coloured spine, and body lines."""
    body = (
        f'<path d="M3.5 1.8h5.2l3.8 3.7v8.7a.8.8 0 0 1-.8.8H3.5a.8.8 0 0 1-.8-.8V2.6a.8.8 0 0 1 .8-.8Z" '
        f'fill="{C["paper"]}"/>'
        f'<path d="M8.7 1.8 12.5 5.5H9.5a.8.8 0 0 1-.8-.8Z" fill="{shade(accent, 0.75)}"/>'
        f'<path d="M3.5 1.8h5.2l3.8 3.7v8.7a.8.8 0 0 1-.8.8H3.5a.8.8 0 0 1-.8-.8V2.6a.8.8 0 0 1 .8-.8Z" '
        f'stroke="{shade(accent, 0.8)}" stroke-width="1" stroke-linejoin="round"/>'
    )
    rows = ""
    for i in range(lines):
        y = 8.2 + i * 2.1
        width = 6.2 if i < lines - 1 else 4.0
        rows += f'<rect x="4.7" y="{y:.1f}" width="{width}" height="1.1" rx="0.55" fill="{accent}"/>'
    return body + rows + mark


def rect_frame(stroke: str, fill: str, inner: str = "") -> str:
    return (
        f'<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.4" fill="{fill}" '
        f'stroke="{stroke}" stroke-width="1.1"/>' + inner
    )


def glyph_text(color: str, char: str, x: float = 8, y: float = 11.2, size: float = 8.5) -> str:
    return (
        f'<text x="{x}" y="{y}" font-family="Segoe UI,Helvetica,Arial,sans-serif" '
        f'font-size="{size}" font-weight="700" text-anchor="middle" fill="{color}">{char}</text>'
    )


# ---------------------------------------------------------------------------
# glyphs
# ---------------------------------------------------------------------------

GLYPHS: dict[str, str] = {}


def add(name: str, body: str) -> None:
    GLYPHS[name] = body


# -- geometry ---------------------------------------------------------------
add("part", cube(C["part"]))
add(
    "mesh",
    cube(C["mesh"])
    + f'<path d="M2 4.9 8 8.2l6-3.3M8 8.2v6.2" stroke="{shade(C["mesh"], 0.55)}" '
    'stroke-width="0.8" opacity="0.9"/>',
)
add(
    "union",
    f'<circle cx="6.2" cy="8" r="4.4" fill="{shade(C["part"], 1.1)}" stroke="{C["partEdge"]}" stroke-width="1"/>'
    f'<rect x="7.4" y="4.6" width="6.8" height="6.8" rx="1.2" fill="{shade(C["part"], 0.85)}" '
    f'stroke="{C["partEdge"]}" stroke-width="1"/>',
)
add(
    "wedge",
    f'<path d="M2 13.4 14 13.4 14 3.2Z" fill="{shade(C["part"], 0.95)}" stroke="{C["partEdge"]}" '
    'stroke-width="1" stroke-linejoin="round"/>',
)
add(
    "terrain",
    f'<path d="M1.5 12.6 5.6 6.2l2.6 3.6 2.3-3.2 4 6Z" fill="{C["humanoid"]}" '
    f'stroke="{shade(C["humanoid"], 0.65)}" stroke-width="1" stroke-linejoin="round"/>'
    f'<circle cx="12.4" cy="4.2" r="1.6" fill="{C["light"]}"/>',
)
add(
    "model",
    f'<path d="M5 2.6 9.4 4.9 5 7.2 0.6 4.9Z" fill="{shade(C["model"], 1.15)}" transform="translate(2 0)"/>'
    + f'<g opacity="0.95"><path d="M4.2 7.2 8 9.2 4.2 11.2 0.4 9.2Z" fill="{shade(C["model"], 0.8)}" '
    'transform="translate(1.4 1.6)"/>'
    f'<path d="M11.8 7.2 15.6 9.2 11.8 11.2 8 9.2Z" fill="{shade(C["model"], 0.65)}" '
    'transform="translate(-1.4 1.6)"/></g>',
)
add(
    "folder",
    f'<path d="M1.6 4.1a1 1 0 0 1 1-1h3.2l1.5 1.7h6.1a1 1 0 0 1 1 1v6.9a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1Z" '
    f'fill="{C["folder"]}"/>'
    f'<path d="M1.6 6.4h12.8v5.3a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1Z" fill="{shade(C["folder"], 1.18)}"/>',
)
add(
    "tool",
    f'<path d="M10.8 1.9a3.4 3.4 0 0 0-4.3 4.3l-4.4 4.4a1.2 1.2 0 0 0 0 1.7l1.6 1.6a1.2 1.2 0 0 0 1.7 0l4.4-4.4'
    f'a3.4 3.4 0 0 0 4.3-4.3l-2 2-1.7-.3-.3-1.7Z" fill="{C["physics"]}" '
    f'stroke="{shade(C["physics"], 0.6)}" stroke-width="0.9" stroke-linejoin="round"/>',
)
add(
    "seat",
    f'<path d="M3.4 2.6h2.2v7.2h6.2v2.2H3.4Z" fill="{C["part"]}" stroke="{C["partEdge"]}" '
    'stroke-width="1" stroke-linejoin="round"/>',
)
add(
    "spawn",
    f'<circle cx="8" cy="8" r="5.6" fill="none" stroke="{C["humanoid"]}" stroke-width="1.6"/>'
    f'<circle cx="8" cy="8" r="2.1" fill="{C["humanoid"]}"/>',
)

# -- scripts ----------------------------------------------------------------
add("script", page(C["script"]))
add("localscript", page(C["local"]))
add(
    "modulescript",
    page(C["module"], lines=0)
    + glyph_text(C["module"], "{}", y=11.6, size=7.2),
)
add(
    "script-disabled",
    page("#8A929B", lines=3)
    + '<path d="M3 13 13 3" stroke="#C0392B" stroke-width="1.4" stroke-linecap="round"/>',
)

# -- ui ---------------------------------------------------------------------
add(
    # Two offset panes, the back one outline-only so it still reads as a stack once the
    # front pane covers most of it.
    "screengui",
    f'<rect x="1.5" y="2.3" width="10.6" height="8.2" rx="1.2" fill="none" '
    f'stroke="{C["ui"]}" stroke-width="1"/>'
    f'<rect x="3.9" y="5.5" width="10.6" height="8.2" rx="1.2" fill="{shade(C["ui"], 1.42)}" '
    f'stroke="{C["ui"]}" stroke-width="1.1"/>'
    f'<path d="M3.9 8.1h10.6" stroke="{C["ui"]}" stroke-width="1" opacity="0.85"/>',
)
add("frame", rect_frame(C["ui"], "none"))
add(
    "textlabel",
    rect_frame(C["ui"], "none", glyph_text(C["ui"], "T", y=11.4, size=8)),
)
add(
    "textbutton",
    rect_frame(C["ui"], shade(C["ui"], 1.5), glyph_text(C["ui"], "T", y=11.4, size=8)),
)
add(
    "textbox",
    rect_frame(C["ui"], "none", f'<path d="M4.4 5.6v4.8M6.6 8h5.2" stroke="{C["ui"]}" '
    'stroke-width="1.1" stroke-linecap="round"/>'),
)
add(
    "imagelabel",
    rect_frame(
        C["ui"],
        "none",
        f'<path d="M2.6 11.6 6.1 7.9l2.2 2.4 2-2 3.1 3.3Z" fill="{C["ui"]}"/>'
        f'<circle cx="5.3" cy="5.9" r="1.1" fill="{C["ui"]}"/>',
    ),
)
add(
    "imagebutton",
    rect_frame(
        C["ui"],
        shade(C["ui"], 1.5),
        f'<path d="M2.6 11.6 6.1 7.9l2.2 2.4 2-2 3.1 3.3Z" fill="{C["ui"]}"/>',
    ),
)
add(
    "scrollingframe",
    rect_frame(
        C["ui"],
        "none",
        f'<rect x="11.2" y="4.2" width="1.6" height="4.2" rx="0.8" fill="{C["ui"]}"/>'
        f'<path d="M3.6 5.6h5.6M3.6 8h5.6M3.6 10.4h4" stroke="{C["ui"]}" stroke-width="1" '
        'stroke-linecap="round" opacity="0.75"/>',
    ),
)
add(
    "uilayout",
    f'<rect x="2" y="2.6" width="12" height="3" rx="0.8" fill="{C["uiSoft"]}" stroke="{C["ui"]}" stroke-width="0.9"/>'
    f'<rect x="2" y="6.6" width="12" height="3" rx="0.8" fill="{C["uiSoft"]}" stroke="{C["ui"]}" stroke-width="0.9"/>'
    f'<rect x="2" y="10.6" width="12" height="3" rx="0.8" fill="{C["uiSoft"]}" stroke="{C["ui"]}" stroke-width="0.9"/>',
)
add(
    "uiconstraint",
    f'<rect x="2.4" y="2.4" width="11.2" height="11.2" rx="2.6" fill="none" stroke="{C["ui"]}" '
    'stroke-width="1.1" stroke-dasharray="2.6 1.8"/>'
    f'<circle cx="8" cy="8" r="1.4" fill="{C["ui"]}"/>',
)

# -- networking -------------------------------------------------------------
add(
    "remoteevent",
    f'<path d="M8.8 1.4 3.2 9.1h3.7l-1.1 5.5 6.2-8.3H8.2Z" fill="{C["remote"]}" '
    f'stroke="{shade(C["remote"], 0.7)}" stroke-width="0.9" stroke-linejoin="round"/>',
)
add(
    "remotefunction",
    f'<path d="M2.4 5.4h8.2M8.2 3 10.8 5.4 8.2 7.8" stroke="{C["remote"]}" stroke-width="1.3" '
    'stroke-linecap="round" stroke-linejoin="round"/>'
    f'<path d="M13.6 10.6H5.4M7.8 8.2 5.2 10.6 7.8 13" stroke="{shade(C["remote"], 0.78)}" '
    'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
)
add(
    "bindableevent",
    f'<path d="M8.8 1.4 3.2 9.1h3.7l-1.1 5.5 6.2-8.3H8.2Z" fill="none" '
    f'stroke="{C["remote"]}" stroke-width="1.2" stroke-linejoin="round"/>',
)
add(
    "bindablefunction",
    f'<path d="M2.4 5.4h8.2M8.2 3 10.8 5.4 8.2 7.8M13.6 10.6H5.4M7.8 8.2 5.2 10.6 7.8 13" '
    f'stroke="{shade(C["remote"], 0.85)}" stroke-width="1.2" stroke-linecap="round" '
    'stroke-linejoin="round" stroke-dasharray="2.4 1.4"/>',
)

# -- values -----------------------------------------------------------------
add(
    "value",
    f'<circle cx="8" cy="8" r="5.8" fill="none" stroke="{C["value"]}" stroke-width="1.2"/>'
    + glyph_text(C["value"], "=", y=11.1, size=8.5),
)
add(
    "objectvalue",
    f'<circle cx="8" cy="8" r="5.8" fill="none" stroke="{C["value"]}" stroke-width="1.2"/>'
    f'<circle cx="8" cy="8" r="2.2" fill="{C["value"]}"/>',
)

# -- physics ----------------------------------------------------------------
add(
    "attachment",
    f'<circle cx="8" cy="8" r="2.4" fill="{C["physics"]}"/>'
    f'<path d="M8 1.6v3M8 11.4v3M1.6 8h3M11.4 8h3" stroke="{C["physics"]}" stroke-width="1.2" '
    'stroke-linecap="round"/>',
)
add(
    "constraint",
    f'<circle cx="3.8" cy="12.2" r="2" fill="none" stroke="{C["physics"]}" stroke-width="1.2"/>'
    f'<circle cx="12.2" cy="3.8" r="2" fill="none" stroke="{C["physics"]}" stroke-width="1.2"/>'
    f'<path d="M5.2 10.8 10.8 5.2" stroke="{C["physics"]}" stroke-width="1.2" stroke-linecap="round"/>',
)
add(
    "weld",
    f'<rect x="2" y="6.4" width="5.4" height="3.2" rx="0.8" fill="{C["physics"]}"/>'
    f'<rect x="8.6" y="6.4" width="5.4" height="3.2" rx="0.8" fill="{shade(C["physics"], 0.78)}"/>'
    f'<path d="M7.2 4.8v6.4" stroke="{shade(C["physics"], 0.55)}" stroke-width="1.4" stroke-linecap="round"/>',
)
add(
    "humanoid",
    f'<circle cx="8" cy="3.9" r="2.3" fill="{C["humanoid"]}"/>'
    f'<path d="M4.4 14.2c0-2.6 1.6-4.4 3.6-4.4s3.6 1.8 3.6 4.4Z" fill="{C["humanoid"]}"/>'
    f'<path d="M2.6 8.4h10.8" stroke="{shade(C["humanoid"], 0.72)}" stroke-width="1.2" stroke-linecap="round"/>',
)
add(
    "animation",
    f'<path d="M2.4 8c0-3 2.5-5.4 5.6-5.4S13.6 5 13.6 8" fill="none" stroke="{C["humanoid"]}" '
    'stroke-width="1.2" stroke-linecap="round"/>'
    f'<path d="M4.6 13.4 8 9.4l3.4 4Z" fill="{C["humanoid"]}"/>',
)

# -- effects, light, sound --------------------------------------------------
add(
    "light",
    f'<path d="M8 2.2a4 4 0 0 0-2.3 7.3v1.6h4.6V9.5A4 4 0 0 0 8 2.2Z" fill="{C["light"]}" '
    f'stroke="{shade(C["light"], 0.65)}" stroke-width="0.9" stroke-linejoin="round"/>'
    f'<path d="M6.2 12.4h3.6M6.8 14h2.4" stroke="{shade(C["light"], 0.6)}" stroke-width="1.2" '
    'stroke-linecap="round"/>',
)
add(
    "sound",
    f'<path d="M3 6.2h2.4L8.8 3.2v9.6L5.4 9.8H3Z" fill="{C["sound"]}"/>'
    f'<path d="M10.8 5.8a3.4 3.4 0 0 1 0 4.4M12.8 3.8a6 6 0 0 1 0 8.4" stroke="{C["sound"]}" '
    'stroke-width="1.2" stroke-linecap="round" fill="none"/>',
)
add(
    "particle",
    f'<circle cx="4.2" cy="11.4" r="2.1" fill="{C["fx"]}"/>'
    f'<circle cx="9.2" cy="8" r="1.6" fill="{shade(C["fx"], 1.08)}"/>'
    f'<circle cx="12.6" cy="4.4" r="1.2" fill="{shade(C["fx"], 1.15)}"/>',
)
add(
    "beam",
    f'<path d="M2 11.6c3.4 0 3.4-7.2 12-7.2v3.2c-6.4 0-6.4 7.2-12 7.2Z" fill="{C["fx"]}" opacity="0.9"/>',
)
add(
    "decal",
    f'<rect x="2.4" y="2.4" width="11.2" height="11.2" rx="1.4" fill="none" stroke="{C["mesh"]}" '
    'stroke-width="1.1"/>'
    f'<path d="M3.4 11.4 6.6 8l2.1 2.3 1.9-2 2 3.1Z" fill="{C["mesh"]}"/>',
)
add(
    "atmosphere",
    f'<circle cx="8" cy="8" r="5.4" fill="none" stroke="{C["camera"]}" stroke-width="1.2"/>'
    f'<path d="M2.8 6.4h10.4M2.8 9.6h10.4" stroke="{C["camera"]}" stroke-width="1" opacity="0.8"/>',
)

# -- misc -------------------------------------------------------------------
add(
    "camera",
    f'<rect x="1.6" y="4.4" width="9" height="7.2" rx="1.4" fill="{C["camera"]}"/>'
    f'<path d="M10.6 8.2 14.4 5.6v4.8L10.6 7.8Z" fill="{shade(C["camera"], 0.78)}"/>',
)
add(
    "player",
    f'<circle cx="8" cy="5" r="2.6" fill="{C["service"]}"/>'
    f'<path d="M3.4 13.8c0-2.5 2-4.2 4.6-4.2s4.6 1.7 4.6 4.2Z" fill="{C["service"]}"/>',
)
add(
    "service",
    f'<path d="M8 1.8 14 5v6L8 14.2 2 11V5Z" fill="none" stroke="{C["service"]}" stroke-width="1.2" '
    'stroke-linejoin="round"/>'
    f'<circle cx="8" cy="8" r="2" fill="{C["service"]}"/>',
)
add(
    "workspace",
    f'<path d="M1.6 11.4 8 14.4l6.4-3V5.2L8 2.2 1.6 5.2Z" fill="none" stroke="{C["part"]}" '
    'stroke-width="1.2" stroke-linejoin="round"/>'
    f'<path d="M1.6 5.2 8 8.2l6.4-3M8 8.2v6.2" stroke="{C["part"]}" stroke-width="1" opacity="0.85"/>',
)
add(
    "storage",
    f'<ellipse cx="8" cy="4" rx="5.6" ry="2.2" fill="none" stroke="{C["service"]}" stroke-width="1.2"/>'
    f'<path d="M2.4 4v8c0 1.2 2.5 2.2 5.6 2.2s5.6-1 5.6-2.2V4" fill="none" stroke="{C["service"]}" '
    'stroke-width="1.2"/>'
    f'<path d="M2.4 8c0 1.2 2.5 2.2 5.6 2.2s5.6-1 5.6-2.2" fill="none" stroke="{C["service"]}" '
    'stroke-width="1" opacity="0.8"/>',
)
add(
    "prompt",
    f'<rect x="1.8" y="3" width="12.4" height="8.4" rx="1.6" fill="none" stroke="{C["value"]}" '
    'stroke-width="1.1"/>'
    f'<path d="M5 11.4 5 14l3-2.6Z" fill="{C["value"]}"/>'
    f'<path d="M5.2 7.2h5.6" stroke="{C["value"]}" stroke-width="1.2" stroke-linecap="round"/>',
)
add(
    # The last-resort glyph. Deliberately a mid grey rather than a tinted ink, so it is
    # legible on both themes without ever competing with a real class icon.
    "instance",
    f'<circle cx="8" cy="8" r="5.4" fill="none" stroke="{C["service"]}" stroke-width="1.3"/>'
    f'<circle cx="8" cy="8" r="1.9" fill="{C["service"]}"/>',
)

# ---------------------------------------------------------------------------
# class / tag mapping
# ---------------------------------------------------------------------------

BY_CLASS: dict[str, str] = {
    # geometry
    "Part": "part",
    "TrussPart": "part",
    "MeshPart": "mesh",
    "SpecialMesh": "mesh",
    "UnionOperation": "union",
    "NegateOperation": "union",
    "IntersectOperation": "union",
    "WedgePart": "wedge",
    "CornerWedgePart": "wedge",
    "Terrain": "terrain",
    "Model": "model",
    "Actor": "model",
    "WorldModel": "model",
    "Folder": "folder",
    "Configuration": "folder",
    "Tool": "tool",
    "Accessory": "tool",
    "HopperBin": "tool",
    "Seat": "seat",
    "VehicleSeat": "seat",
    "SpawnLocation": "spawn",
    # scripts
    "Script": "script",
    "LocalScript": "localscript",
    "ModuleScript": "modulescript",
    # ui
    "ScreenGui": "screengui",
    "SurfaceGui": "screengui",
    "BillboardGui": "screengui",
    "Frame": "frame",
    "CanvasGroup": "frame",
    "ViewportFrame": "frame",
    "VideoFrame": "frame",
    "ScrollingFrame": "scrollingframe",
    "TextLabel": "textlabel",
    "TextButton": "textbutton",
    "TextBox": "textbox",
    "ImageLabel": "imagelabel",
    "ImageButton": "imagebutton",
    # networking
    "RemoteEvent": "remoteevent",
    "UnreliableRemoteEvent": "remoteevent",
    "RemoteFunction": "remotefunction",
    "BindableEvent": "bindableevent",
    "BindableFunction": "bindablefunction",
    # values
    "ObjectValue": "objectvalue",
    # physics
    "Attachment": "attachment",
    "Bone": "attachment",
    "Weld": "weld",
    "WeldConstraint": "weld",
    "Motor6D": "weld",
    "Humanoid": "humanoid",
    "Animator": "animation",
    "Animation": "animation",
    "AnimationController": "animation",
    # effects
    "ParticleEmitter": "particle",
    "Sparkles": "particle",
    "Smoke": "particle",
    "Fire": "particle",
    "Explosion": "particle",
    "Beam": "beam",
    "Trail": "beam",
    "Decal": "decal",
    "Texture": "decal",
    "SurfaceAppearance": "decal",
    "Atmosphere": "atmosphere",
    "Sky": "atmosphere",
    "Clouds": "atmosphere",
    "Sound": "sound",
    "SoundGroup": "sound",
    "PointLight": "light",
    "SpotLight": "light",
    "SurfaceLight": "light",
    # misc
    "Camera": "camera",
    "Player": "player",
    "Team": "player",
    "ProximityPrompt": "prompt",
    "ClickDetector": "prompt",
    "Dialog": "prompt",
    # services
    "Workspace": "workspace",
    "ReplicatedStorage": "storage",
    "ServerStorage": "storage",
    "ReplicatedFirst": "storage",
    "ServerScriptService": "script",
    "StarterPlayerScripts": "localscript",
    "StarterCharacterScripts": "localscript",
    "Lighting": "light",
    "SoundService": "sound",
    "Players": "player",
    "Teams": "player",
    "StarterGui": "screengui",
    "MaterialService": "decal",
    "StarterPack": "tool",
    "StarterPlayer": "player",
    "TextChatService": "prompt",
    "Chat": "prompt",
}

# Walked in order only after an exact class match fails. Mirrors the tag order the
# plugin sends, so the first hit is always the most specific base class.
BY_TAG: dict[str, str] = {
    "ModuleScript": "modulescript",
    "LocalScript": "localscript",
    "Script": "script",
    "BaseScript": "script",
    "LuaSourceContainer": "script",
    "MeshPart": "mesh",
    "UnionOperation": "union",
    "Terrain": "terrain",
    "WedgePart": "wedge",
    "CornerWedgePart": "wedge",
    "SpawnLocation": "spawn",
    "Seat": "seat",
    "VehicleSeat": "seat",
    "Part": "part",
    "BasePart": "part",
    "Model": "model",
    "Tool": "tool",
    "Accessory": "tool",
    "Folder": "folder",
    "Configuration": "folder",
    "ScreenGui": "screengui",
    "SurfaceGui": "screengui",
    "BillboardGui": "screengui",
    "LayerCollector": "screengui",
    "TextButton": "textbutton",
    "ImageButton": "imagebutton",
    "TextLabel": "textlabel",
    "TextBox": "textbox",
    "ImageLabel": "imagelabel",
    "ScrollingFrame": "scrollingframe",
    "CanvasGroup": "frame",
    "VideoFrame": "frame",
    "ViewportFrame": "frame",
    "Frame": "frame",
    "UIGridLayout": "uilayout",
    "UIListLayout": "uilayout",
    "UIPadding": "uiconstraint",
    "UICorner": "uiconstraint",
    "UIStroke": "uiconstraint",
    "UIGradient": "uiconstraint",
    "UIScale": "uiconstraint",
    "UIAspectRatioConstraint": "uiconstraint",
    "UIComponent": "uiconstraint",
    "GuiButton": "textbutton",
    "GuiLabel": "textlabel",
    "GuiObject": "frame",
    "GuiBase": "frame",
    "RemoteEvent": "remoteevent",
    "UnreliableRemoteEvent": "remoteevent",
    "RemoteFunction": "remotefunction",
    "BindableEvent": "bindableevent",
    "BindableFunction": "bindablefunction",
    "ObjectValue": "objectvalue",
    "StringValue": "value",
    "IntValue": "value",
    "NumberValue": "value",
    "BoolValue": "value",
    "CFrameValue": "value",
    "Vector3Value": "value",
    "Color3Value": "value",
    "BrickColorValue": "value",
    "RayValue": "value",
    "ValueBase": "value",
    "Motor6D": "weld",
    "Weld": "weld",
    "WeldConstraint": "weld",
    "Attachment": "attachment",
    "Constraint": "constraint",
    "JointInstance": "weld",
    "BodyMover": "constraint",
    "Humanoid": "humanoid",
    "HumanoidDescription": "humanoid",
    "Animator": "animation",
    "Animation": "animation",
    "AnimationController": "animation",
    "ParticleEmitter": "particle",
    "Beam": "beam",
    "Trail": "beam",
    "Explosion": "particle",
    "Fire": "particle",
    "Smoke": "particle",
    "Sparkles": "particle",
    "Highlight": "decal",
    "SelectionBox": "decal",
    "Sound": "sound",
    "SoundGroup": "sound",
    "SoundEffect": "sound",
    "PointLight": "light",
    "SpotLight": "light",
    "SurfaceLight": "light",
    "Light": "light",
    "Decal": "decal",
    "Texture": "decal",
    "SurfaceAppearance": "decal",
    "Atmosphere": "atmosphere",
    "Sky": "atmosphere",
    "PostEffect": "atmosphere",
    "Camera": "camera",
    "Player": "player",
    "Team": "player",
    "ClickDetector": "prompt",
    "ProximityPrompt": "prompt",
    "Mesh": "mesh",
    "PVInstance": "part",
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="extension/media", help="media directory to write into")
    args = parser.parse_args()

    out = Path(args.out).resolve()
    icons = out / "icons"
    icons.mkdir(parents=True, exist_ok=True)

    for name, body in GLYPHS.items():
        (icons / f"{name}.svg").write_text(HEAD + body + TAIL, encoding="utf-8")

    # Every mapped glyph must exist, or the extension silently renders nothing.
    missing = sorted(
        {g for g in BY_CLASS.values() if g not in GLYPHS}
        | {g for g in BY_TAG.values() if g not in GLYPHS}
        | {g for g in ("instance", "service", "script-disabled") if g not in GLYPHS}
    )
    if missing:
        raise SystemExit(f"map references glyphs that were never drawn: {missing}")

    manifest = {
        "note": "Original artwork for Explorer Link. Not derived from Roblox's Explorer icons.",
        "fallback": "instance",
        # Any top-level service without a glyph of its own: better a service marker than
        # the generic instance dot, and it means new services need no map entry.
        "serviceFallback": "service",
        "disabledOverlay": "script-disabled",
        "byClass": BY_CLASS,
        "byTag": BY_TAG,
    }
    (out / "icon-map.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(f"wrote {len(GLYPHS)} glyphs to {icons}")
    print(f"wrote map covering {len(BY_CLASS)} classes and {len(BY_TAG)} tags")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
