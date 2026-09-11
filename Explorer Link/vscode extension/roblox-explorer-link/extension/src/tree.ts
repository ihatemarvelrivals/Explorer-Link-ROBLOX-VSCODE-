/**
 * The Explorer view.
 *
 * Elements are refs (plain strings), not node objects, so incremental updates never
 * have to worry about object identity: the caches below are the single source of truth
 * and a refresh is just a change notification for one ref.
 *
 * Children are fetched on expand. Nothing walks the DataModel, here or in the plugin.
 */

import * as vscode from 'vscode';

import { IconResolver } from './icons';
import { GetChildrenResult, PluginEvent, RbxNode } from './protocol';
import { ServerHandle } from './server';
import { SyncMap } from './syncMap';

export class ExplorerTreeProvider implements vscode.TreeDataProvider<string> {
  private changed = new vscode.EventEmitter<string | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;

  private nodes = new Map<string, RbxNode>();
  private children = new Map<string, string[]>();
  private parents = new Map<string, string>();
  private roots: string[] = [];
  private inFlight = new Map<string, Promise<string[]>>();

  constructor(
    private handle: ServerHandle,
    private icons: IconResolver,
    private syncMap: SyncMap,
  ) {}

  // -- data -----------------------------------------------------------------

  node(ref: string): RbxNode | undefined {
    return this.nodes.get(ref);
  }

  getParent(ref: string): string | undefined {
    return this.parents.get(ref);
  }

  getChildren(ref?: string): vscode.ProviderResult<string[]> {
    if (!this.handle.current.isConnected) {
      return [];
    }
    if (!ref) {
      return this.roots;
    }

    const cached = this.children.get(ref);
    if (cached) {
      return cached;
    }

    // Two expands of the same node before the first answers must not become two
    // round trips, or a fast double-click doubles the request cost.
    const existing = this.inFlight.get(ref);
    if (existing) {
      return existing;
    }

    const request = this.handle.current
      .send<GetChildrenResult>('getChildren', { ref })
      .then((result) => {
        const refs = result.nodes.map((node) => {
          this.nodes.set(node.ref, node);
          this.parents.set(node.ref, ref);
          return node.ref;
        });
        this.children.set(ref, refs);
        // Resolving the disk files is what lets these rows carry git decorations, but
        // it touches the filesystem, so it happens after the rows are already on screen.
        void this.syncMap.warm(result.nodes).then(() => this.changed.fire(ref));
        return refs;
      })
      .catch((error: Error) => {
        // A stale ref means the instance is gone; the parent's own removal event will
        // clean up the row shortly, so fail quietly rather than popping a dialog.
        if (!/stale-ref|not-connected|disconnected/.test(error.message)) {
          vscode.window.showWarningMessage(`Explorer Link: ${error.message}`);
        }
        return [];
      })
      .finally(() => {
        this.inFlight.delete(ref);
      });

    this.inFlight.set(ref, request);
    return request;
  }

  getTreeItem(ref: string): vscode.TreeItem {
    const node = this.nodes.get(ref);
    if (!node) {
      return new vscode.TreeItem('…');
    }

    const config = vscode.workspace.getConfiguration('explorerLink');
    const item = new vscode.TreeItem(
      node.name,
      node.childCount > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    item.id = ref;
    item.iconPath = this.icons.iconFor(node);
    item.contextValue = node.flags?.script ? 'instance script' : 'instance';

    // A script that Script Sync has written to disk gets its file attached to the row.
    // VS Code then runs its own decorators over it, so the tree picks up git status
    // colouring for free — modified scripts stand out here exactly as they do in the
    // file explorer.
    const file = node.flags?.script ? this.syncMap.cached(node) : undefined;
    if (file) {
      item.resourceUri = file;
      item.contextValue = 'instance script synced';
    }

    if (config.get<boolean>('showClassNames', true) && node.className !== node.name) {
      item.description = node.className;
    }

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${node.name}** — \`${node.className}\`\n\n`);
    tooltip.appendMarkdown(`\`${node.path}\`\n\n`);
    if (file) {
      tooltip.appendMarkdown(`Synced to \`${SyncMap.relative(file)}\`\n\n`);
    }
    if (node.childCount > 0) {
      tooltip.appendMarkdown(`${node.childCount} ${node.childCount === 1 ? 'child' : 'children'}`);
    }
    if (node.flags?.disabled) {
      tooltip.appendMarkdown(`\n\n_Disabled_`);
    }
    item.tooltip = tooltip;

    if (node.flags?.script && config.get<boolean>('openScriptOnClick', true)) {
      item.command = {
        command: 'explorerLink.openScript',
        title: 'Open Script',
        arguments: [ref],
      };
    }

    return item;
  }

  // -- live updates ---------------------------------------------------------

  handleEvent(event: PluginEvent): void {
    switch (event.type) {
      case 'roots': {
        this.reset();
        this.roots = event.nodes.map((node) => {
          this.nodes.set(node.ref, node);
          return node.ref;
        });
        this.changed.fire();
        break;
      }

      case 'childAdded': {
        this.nodes.set(event.node.ref, event.node);
        this.parents.set(event.node.ref, event.parent);
        const siblings = this.children.get(event.parent);
        if (siblings) {
          // The plugin reports Studio's own child order; honour it when it is sane.
          const index = event.index >= 1 && event.index <= siblings.length + 1
            ? event.index - 1
            : siblings.length;
          siblings.splice(index, 0, event.node.ref);
        }
        this.bumpChildCount(event.parent, +1);
        this.changed.fire(event.parent);
        break;
      }

      case 'childRemoved': {
        const siblings = this.children.get(event.parent);
        if (siblings) {
          const index = siblings.indexOf(event.ref);
          if (index >= 0) {
            siblings.splice(index, 1);
          }
        }
        this.forget(event.ref);
        this.bumpChildCount(event.parent, -1);
        this.changed.fire(event.parent);
        break;
      }

      case 'nodeChanged': {
        const previous = this.nodes.get(event.node.ref);
        this.nodes.set(event.node.ref, event.node);
        // A row whose name changed still lives under the same parent; refreshing the
        // parent redraws the label without collapsing anything below it.
        const parent = this.parents.get(event.node.ref);
        if (previous && previous.childCount === 0 && event.node.childCount > 0) {
          // It just grew its first child, so it needs a twisty: the row itself has to
          // be rebuilt, which only a parent-level refresh will do.
          this.changed.fire(parent);
        } else {
          this.changed.fire(event.node.ref);
        }
        break;
      }

      default:
        break;
    }
  }

  private bumpChildCount(ref: string, delta: number): void {
    const node = this.nodes.get(ref);
    if (node) {
      node.childCount = Math.max(0, node.childCount + delta);
    }
  }

  /** Drops a ref and everything cached beneath it. */
  private forget(ref: string): void {
    const stack = [ref];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const kids = this.children.get(current);
      if (kids) {
        stack.push(...kids);
        this.children.delete(current);
      }
      this.nodes.delete(current);
      this.parents.delete(current);
    }
  }

  reset(): void {
    this.nodes.clear();
    this.children.clear();
    this.parents.clear();
    this.inFlight.clear();
    this.roots = [];
  }

  clear(): void {
    this.reset();
    this.changed.fire();
  }

  /** Forces a re-fetch of everything currently open. */
  refresh(): void {
    this.children.clear();
    this.inFlight.clear();
    this.changed.fire();
  }

  // -- path walking ---------------------------------------------------------

  /**
   * Resolves `["Workspace", "Sword", "Handle"]` to a ref, loading each level on the way
   * so the ancestors are known to `getParent` and `reveal` can actually scroll to it.
   */
  async refForPath(segments: string[]): Promise<string | undefined> {
    if (segments.length === 0) {
      return undefined;
    }

    let current = this.roots.find((ref) => this.nodes.get(ref)?.name === segments[0]);
    if (!current) {
      return undefined;
    }

    for (const segment of segments.slice(1)) {
      const kids = await this.getChildren(current);
      const list = Array.isArray(kids) ? kids : await kids;
      if (!list) {
        return undefined;
      }
      const next = list.find((ref) => this.nodes.get(ref)?.name === segment);
      if (!next) {
        return undefined;
      }
      current = next;
    }

    return current;
  }

  /** Every ref currently loaded, for the "Go to Path" quick pick. */
  loadedNodes(): RbxNode[] {
    return [...this.nodes.values()];
  }

  /** The children of `ref` if they have been fetched, without triggering a fetch. */
  cachedChildren(ref: string): string[] | undefined {
    return this.children.get(ref);
  }
}
