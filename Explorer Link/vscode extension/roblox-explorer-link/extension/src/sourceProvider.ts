/**
 * Read-only script source, served through a virtual document scheme.
 *
 * URIs look like:
 *
 *     rbxlink:/Workspace/Sword/Attack.server.lua?i%3A42
 *
 * The path exists to give the editor tab a name a human recognises and to pick up Lua
 * syntax highlighting from the extension; the query is the ref, which is the part that
 * actually identifies the instance. Rojo's suffix convention (.server.lua / .client.lua)
 * is reused so the tab reads the way the same file would on disk.
 */

import * as vscode from 'vscode';

import { GetSourceResult } from './protocol';
import { ServerHandle } from './server';

export const SCHEME = 'rbxlink';

function suffixFor(className: string): string {
  if (className === 'Script') {
    return '.server.lua';
  }
  if (className === 'LocalScript') {
    return '.client.lua';
  }
  return '.lua';
}

export function uriFor(path: string, className: string, ref: string): vscode.Uri {
  // "game.Workspace.Sword.Attack" -> "/Workspace/Sword/Attack.server.lua"
  const segments = path.split('.').slice(1);
  const name = segments.pop() ?? 'Script';
  const dir = segments.length > 0 ? `/${segments.join('/')}` : '';
  return vscode.Uri.parse(
    `${SCHEME}:${dir}/${encodeURIComponent(name)}${suffixFor(className)}?${encodeURIComponent(ref)}`,
  );
}

export function refFromUri(uri: vscode.Uri): string {
  return decodeURIComponent(uri.query);
}

export class SourceProvider implements vscode.TextDocumentContentProvider {
  private changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  /** ref -> uri, so a sourceChanged event can find the document to invalidate. */
  private open = new Map<string, vscode.Uri>();

  constructor(private handle: ServerHandle) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const ref = refFromUri(uri);
    if (!this.handle.current.isConnected) {
      return '-- Explorer Link: no Studio session is connected.\n';
    }
    try {
      const result = await this.handle.current.send<GetSourceResult>('getSource', { ref });
      this.open.set(ref, uri);
      return result.source ?? '';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('stale-ref')) {
        return '-- Explorer Link: this instance no longer exists in the open place.\n';
      }
      if (message.includes('source-unavailable')) {
        return '-- Explorer Link: source is not readable (the script may be inside a protected model).\n';
      }
      return `-- Explorer Link: could not read source (${message}).\n`;
    }
  }

  /** Called when Studio reports the script changed; VS Code then re-reads it. */
  invalidate(ref: string): void {
    const uri = this.open.get(ref);
    if (uri) {
      this.changed.fire(uri);
    }
  }

  /** Re-reads everything on reconnect, so stale tabs do not linger after a restart. */
  invalidateAll(): void {
    for (const uri of this.open.values()) {
      this.changed.fire(uri);
    }
  }

  release(ref: string): void {
    this.open.delete(ref);
    if (this.handle.current.isConnected) {
      void this.handle.current.send('releaseSource', { ref }).catch(() => undefined);
    }
  }

  openRefs(): string[] {
    return [...this.open.keys()];
  }
}
