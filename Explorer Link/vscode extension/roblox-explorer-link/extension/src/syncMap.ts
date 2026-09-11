/**
 * Finds the file Roblox's Script Sync wrote for a given instance, by searching the
 * workspace for the names syncPaths.ts says are plausible and keeping the best match.
 *
 * A wrong answer here means opening the wrong file and editing the wrong script, so an
 * ambiguous result resolves to nothing and the caller falls back to the read-only view.
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { RbxNode } from './protocol';
import { ScoredFile, ancestorsOf, candidatesFor, pickBest } from './syncPaths';

export class SyncMap {
  /** instance path -> resolved file, or null for "looked, found nothing". */
  private cache = new Map<string, vscode.Uri | null>();
  private watcher: vscode.FileSystemWatcher | undefined;

  constructor() {
    // Files appear and disappear as Script Sync runs, so a negative result is only good
    // until the next .luau lands anywhere in the workspace.
    if (vscode.workspace.workspaceFolders?.length) {
      this.watcher = vscode.workspace.createFileSystemWatcher('**/*.{luau,lua}');
      this.watcher.onDidCreate(() => this.invalidate());
      this.watcher.onDidDelete(() => this.invalidate());
    }
  }

  invalidate(): void {
    this.cache.clear();
  }

  dispose(): void {
    this.watcher?.dispose();
  }

  /** The cached answer, without going to disk. Used to decorate tree rows cheaply. */
  cached(node: RbxNode): vscode.Uri | undefined {
    return this.cache.get(node.path) ?? undefined;
  }

  /**
   * Finds the on-disk file for a script node, or undefined if it is not synced (or the
   * match is too ambiguous to trust).
   */
  async fileFor(node: RbxNode): Promise<vscode.Uri | undefined> {
    if (!node.flags?.script || !vscode.workspace.workspaceFolders?.length) {
      return undefined;
    }

    const hit = this.cache.get(node.path);
    if (hit !== undefined) {
      return hit ?? undefined;
    }

    const candidates = candidatesFor(node.name, node.className, node.childCount > 0);
    const found: ScoredFile[] = [];

    for (const candidate of candidates) {
      const matches = await vscode.workspace.findFiles(
        `**/${candidate.fileName}`,
        '**/{node_modules,.git,out,dist}/**',
        32,
      );
      for (const match of matches) {
        found.push({ filePath: match.fsPath, candidate });
      }
    }

    const chosen = pickBest(ancestorsOf(node.path), node.name, found);
    const uri = chosen ? vscode.Uri.file(chosen) : null;
    this.cache.set(node.path, uri);
    return uri ?? undefined;
  }

  /** Warms the cache for a batch of nodes, so tree rows can be decorated on arrival. */
  async warm(nodes: RbxNode[]): Promise<void> {
    await Promise.all(nodes.filter((node) => node.flags?.script).map((node) => this.fileFor(node)));
  }

  /** The workspace folder a resolved file sits in — where a git repo would belong. */
  static workspaceFolderFor(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.getWorkspaceFolder(uri);
  }

  /** Pretty relative path for messages, e.g. `src/Modules/Combat.luau`. */
  static relative(uri: vscode.Uri): string {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder ? path.relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath;
  }
}
