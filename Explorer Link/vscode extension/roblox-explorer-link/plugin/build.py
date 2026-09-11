#!/usr/bin/env python3
"""Pack plugin/src into a single installable ExplorerLink.rbxmx.

Rojo can build this too (`rojo build plugin -o ExplorerLink.rbxmx`), but requiring a
Rust toolchain to install a plugin is a poor trade for a file this simple. This packer
has no dependencies beyond the standard library.

    python3 plugin/build.py [--out DIR]

The result is a Script named ExplorerLink whose children are the sibling ModuleScripts,
which is exactly the shape `require(script.Config)` and `script.Parent.Log` expect.
Drop it into your Studio plugins folder.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT_NAME = "ExplorerLink"
ENTRY = "init.server.lua"


def cdata(text: str) -> str:
    """Wrap source in CDATA, splitting any literal ']]>' that would end it early."""
    return "<![CDATA[" + text.replace("]]>", "]]]]><![CDATA[>") + "]]>"


def item(class_name: str, name: str, source: str, referent: int, children: str = "") -> str:
    return (
        f'\t<Item class="{class_name}" referent="RBX{referent}">\n'
        f"\t\t<Properties>\n"
        f'\t\t\t<string name="Name">{name}</string>\n'
        f'\t\t\t<ProtectedString name="Source">{cdata(source)}</ProtectedString>\n'
        f"\t\t</Properties>\n"
        f"{children}"
        f"\t</Item>\n"
    )


def build(src: Path) -> str:
    entry = src / ENTRY
    if not entry.is_file():
        raise SystemExit(f"missing entry point: {entry}")

    modules = sorted(p for p in src.glob("*.lua") if p.name != ENTRY)
    if not modules:
        raise SystemExit(f"no modules found beside {ENTRY}")

    referent = 1
    children = []
    for module in modules:
        referent += 1
        body = item("ModuleScript", module.stem, module.read_text(encoding="utf-8"), referent)
        # Nest one level deeper than the root Item.
        children.append("\t" + body.replace("\n\t", "\n\t\t").rstrip() + "\n")

    root = item("Script", ROOT_NAME, entry.read_text(encoding="utf-8"), 0, "".join(children))

    return (
        '<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
        'xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">\n'
        f"{root}"
        "</roblox>\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=".", help="directory to write ExplorerLink.rbxmx into")
    args = parser.parse_args()

    src = Path(__file__).resolve().parent / "src"
    xml = build(src)

    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{ROOT_NAME}.rbxmx"
    out.write_text(xml, encoding="utf-8")

    modules = len(sorted(p for p in src.glob("*.lua"))) - 1
    print(f"wrote {out} ({modules} modules, {len(xml):,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
