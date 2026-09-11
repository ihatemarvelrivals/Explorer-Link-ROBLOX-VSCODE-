/**
 * The Properties view: Studio's property groups, flattened into a two-level tree.
 *
 * Values arrive pre-formatted from the plugin — the extension only decides how to
 * colour them, which is what `kind` is for.
 */

import * as vscode from 'vscode';

import { GetPropertiesResult, PropertyGroup, PropertyRow } from './protocol';
import { ServerHandle } from './server';

export type Element = { kind: 'group'; group: PropertyGroup } | { kind: 'row'; row: PropertyRow };

/** Codicon per value kind. Colour comes from the icon's theme colour, not the SVG. */
const ICON_BY_KIND: Record<string, string> = {
  string: 'symbol-text',
  number: 'symbol-numeric',
  bool: 'symbol-boolean',
  enum: 'symbol-enum',
  class: 'symbol-class',
  Instance: 'symbol-reference',
  Vector3: 'symbol-array',
  Vector2: 'symbol-array',
  CFrame: 'symbol-array',
  UDim: 'symbol-array',
  UDim2: 'symbol-array',
  Rect: 'symbol-array',
  Color3: 'symbol-color',
  BrickColor: 'symbol-color',
  ColorSequence: 'symbol-color',
  NumberRange: 'symbol-numeric',
  NumberSequence: 'symbol-numeric',
  Font: 'symbol-text',
  nil: 'circle-outline',
};

export class PropertiesProvider implements vscode.TreeDataProvider<Element> {
  private changed = new vscode.EventEmitter<Element | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;

  private groups: PropertyGroup[] = [];
  private currentRef: string | undefined;
  private requestToken = 0;

  constructor(private handle: ServerHandle) {}

  getChildren(element?: Element): Element[] {
    if (!element) {
      return this.groups.map((group) => ({ kind: 'group', group }));
    }
    if (element.kind === 'group') {
      return element.group.rows.map((row) => ({ kind: 'row', row }));
    }
    return [];
  }

  getTreeItem(element: Element): vscode.TreeItem {
    if (element.kind === 'group') {
      const item = new vscode.TreeItem(
        element.group.name,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = 'propertyGroup';
      item.iconPath = new vscode.ThemeIcon('symbol-namespace');
      return item;
    }

    const item = new vscode.TreeItem(element.row.key, vscode.TreeItemCollapsibleState.None);
    item.description = element.row.value;
    item.contextValue = 'propertyRow';
    item.iconPath = new vscode.ThemeIcon(ICON_BY_KIND[element.row.kind] ?? 'symbol-property');
    item.tooltip = new vscode.MarkdownString(
      `**${element.row.key}**\n\n\`${element.row.value}\`\n\n_${element.row.kind}_\n\nClick to copy the value.`,
    );
    // Click copies. A value you can see but not get out of the panel is half a feature,
    // and a single click is the shortest path to the common case.
    item.command = {
      command: 'explorerLink.copyPropertyValue',
      title: 'Copy Value',
      arguments: [element],
    };
    return item;
  }

  /**
   * Shows properties for `ref`. Selections change faster than round trips complete, so
   * a late answer for a node the user has already moved off is discarded.
   */
  async show(ref: string | undefined): Promise<void> {
    this.currentRef = ref;
    const token = ++this.requestToken;

    if (!ref || !this.handle.current.isConnected) {
      this.groups = [];
      this.changed.fire();
      return;
    }

    try {
      const result = await this.handle.current.send<GetPropertiesResult>('getProperties', { ref });
      if (token !== this.requestToken) {
        return;
      }
      this.groups = result.groups ?? [];
    } catch {
      if (token !== this.requestToken) {
        return;
      }
      this.groups = [];
    }
    this.changed.fire();
  }

  /** Everything currently displayed, as `Group.Key = value` lines. */
  asText(): string {
    const lines: string[] = [];
    for (const group of this.groups) {
      lines.push(`-- ${group.name}`);
      for (const row of group.rows) {
        lines.push(`${row.key} = ${row.value}`);
      }
      lines.push('');
    }
    return lines.join('\n').trimEnd();
  }

  /** One group, as `Key = value` lines. */
  static groupAsText(group: PropertyGroup): string {
    return group.rows.map((row) => `${row.key} = ${row.value}`).join('\n');
  }

  /** True when the panel is currently showing `ref`. */
  isShowing(ref: string): boolean {
    return this.currentRef === ref;
  }

  /** Re-reads the current node, e.g. after the user changed something in Studio. */
  refresh(): void {
    void this.show(this.currentRef);
  }

  clear(): void {
    this.currentRef = undefined;
    this.groups = [];
    this.requestToken++;
    this.changed.fire();
  }
}
