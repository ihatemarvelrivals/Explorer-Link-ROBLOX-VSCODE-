/**
 * Roblox Explorer Link — VS Code side.
 *
 * Owns the link server, the two views, and the read-only source scheme, and wires the
 * plugin's events onto them.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { IconResolver } from './icons';
import { Element as PropertyElement, PropertiesProvider } from './properties';
import { PreviewProvider, previewAssetsPresent } from './preview';
import { PluginEvent, SelectionChangedEvent } from './protocol';
import { LinkServer, ServerHandle, SessionInfo } from './server';
import { SCHEME, SourceProvider, refFromUri, uriFor } from './sourceProvider';
import { SyncMap } from './syncMap';
import { ExplorerTreeProvider } from './tree';

const TOKEN_KEY = 'explorerLink.token';

/** Mutable box the providers read through, so a restart never re-wires them. */
const handle: { current: LinkServer } = { current: undefined as unknown as LinkServer };

let output: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Roblox Explorer Link');
  context.subscriptions.push(output);

  const config = () => vscode.workspace.getConfiguration('explorerLink');

  // One token per machine, not per session: retyping it into Studio on every VS Code
  // restart would make the pairing step feel broken.
  let token = context.globalState.get<string>(TOKEN_KEY);
  if (!token) {
    token = new LinkServer(undefined, 0, 0).token;
    await context.globalState.update(TOKEN_KEY, token);
  }

  const icons = new IconResolver(context.extensionPath);
  const syncMap = new SyncMap();
  context.subscriptions.push({ dispose: () => syncMap.dispose() });
  const tree = new ExplorerTreeProvider(handle as ServerHandle, icons, syncMap);
  const properties = new PropertiesProvider(handle as ServerHandle);
  const source = new SourceProvider(handle as ServerHandle);
  const preview = new PreviewProvider(context.extensionUri, handle as ServerHandle);
  if (!previewAssetsPresent(context.extensionPath)) {
    // Packaging can drop media/ if .vscodeignore is edited carelessly; better a line in
    // the log than a panel that silently never draws.
    output.appendLine('warning: media/preview.js or preview.css is missing — the 3D preview will not draw.');
  }

  const treeView = vscode.window.createTreeView('explorerLink.tree', {
    treeDataProvider: tree,
    showCollapseAll: true,
    canSelectMany: true,
  });
  const propertiesView = vscode.window.createTreeView('explorerLink.properties', {
    treeDataProvider: properties,
  });
  context.subscriptions.push(treeView, propertiesView);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PreviewProvider.viewType, preview, {
      // Rebuilding the WebGL context and re-uploading the meshes every time the panel
      // is collapsed would make it feel broken; the state here is a few hundred KB.
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, source));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'explorerLink.showToken';
  status.show();
  context.subscriptions.push(status);

  // Selection can bounce both ways; this flag breaks the loop while we are the ones
  // applying a change that came from the other side.
  let applyingRemoteSelection = false;

  function setStatus(session: SessionInfo | undefined): void {
    const port = handle.current?.listeningPort ?? config().get<number>('port', 34873);
    if (session) {
      status.text = `$(plug) ${session.placeName}`;
      status.tooltip = new vscode.MarkdownString(
        `**Roblox Explorer Link** — connected\n\n` +
          `Place: \`${session.placeName}\` (${session.placeId || 'unsaved'})\n\n` +
          `Studio ${session.studioVersion || 'unknown'} · plugin v${session.pluginVersion}\n\n` +
          `Port ${port}\n\nClick to show the pairing token.`,
      );
    } else {
      status.text = '$(debug-disconnect) Roblox: waiting';
      status.tooltip = new vscode.MarkdownString(
        `**Roblox Explorer Link** — listening on port ${port}\n\n` +
          `Open the Explorer Link panel in Studio and paste the pairing token.\n\nClick to show it.`,
      );
    }
  }

  async function followStudioSelection(event: SelectionChangedEvent): Promise<void> {
    if (!config().get<boolean>('followStudioSelection', true)) {
      return;
    }
    const first = event.paths?.[0];
    if (!first || first.length === 0 || !treeView.visible) {
      return;
    }
    try {
      const ref = await tree.refForPath(first);
      if (!ref) {
        return;
      }
      applyingRemoteSelection = true;
      await treeView.reveal(ref, { select: true, focus: false, expand: true });
      void properties.show(ref);
    } catch (error) {
      output.appendLine(`could not reveal Studio selection: ${String(error)}`);
    } finally {
      applyingRemoteSelection = false;
    }
  }

  /** Registers every listener on a freshly constructed server. */
  function wire(server: LinkServer): void {
    server.on('listening', (port) => {
      output.appendLine(`listening on http://localhost:${port}`);
      setStatus(undefined);
    });

    server.on('connected', (session) => {
      output.appendLine(
        `connected: ${session.placeName} (place ${session.placeId}), plugin v${session.pluginVersion}`,
      );
      setStatus(session);
      tree.reset();
      properties.clear();
      // Tabs opened against the previous session hold refs that mean nothing now.
      source.invalidateAll();
    });

    server.on('disconnected', (reason) => {
      output.appendLine(`disconnected: ${reason}`);
      setStatus(undefined);
      tree.clear();
      properties.clear();
      preview.clear();
    });

    server.on('event', (event: PluginEvent) => {
      tree.handleEvent(event);

      switch (event.type) {
        case 'sourceChanged':
          source.invalidate(event.ref);
          break;

        case 'nodeChanged':
          // Only re-read when the panel is showing the node that actually changed —
          // otherwise a rename anywhere in the place would cost a round trip.
          if (properties.isShowing(event.node.ref)) {
            properties.refresh();
          }
          break;

        case 'placeChanged':
          if (server.session) {
            server.session.placeName = event.placeName;
            server.session.placeId = event.placeId;
            setStatus(server.session);
          }
          break;

        case 'selectionChanged':
          void followStudioSelection(event);
          break;

        default:
          break;
      }
    });
  }

  async function startServer(): Promise<void> {
    const server = new LinkServer(
      token,
      config().get<number>('port', 34873),
      config().get<number>('holdMs', 20000),
    );
    wire(server);
    handle.current = server;
    tree.clear();
    properties.clear();
    try {
      await server.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Explorer Link: ${message}`);
      output.appendLine(`failed to start: ${message}`);
    }
    setStatus(undefined);
  }

  async function restartServer(): Promise<void> {
    await handle.current?.stop();
    await startServer();
  }

  // -- view interaction -----------------------------------------------------

  context.subscriptions.push(
    treeView.onDidChangeSelection((selection) => {
      const refs = [...selection.selection];
      void properties.show(refs[0]);
      void preview.show(refs[0], refs[0] ? tree.node(refs[0]) : undefined);

      if (applyingRemoteSelection || refs.length === 0) {
        return;
      }
      if (!config().get<boolean>('syncSelectionToStudio', true)) {
        return;
      }
      void handle.current.send('select', { refs }).catch(() => undefined);
    }),
  );

  context.subscriptions.push(
    // Collapsing a node is the signal to stop watching it in Studio. This is what keeps
    // an idle session free of listeners no matter how large the place is.
    treeView.onDidCollapseElement((collapsed) => {
      void handle.current.send('unsubscribe', { refs: [collapsed.element] }).catch(() => undefined);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === SCHEME) {
        source.release(refFromUri(document.uri));
      }
    }),
  );

  // -- commands -------------------------------------------------------------

  const register = (name: string, handler: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(name, handler));

  register('explorerLink.showToken', async () => {
    const port = handle.current?.listeningPort ?? config().get<number>('port', 34873);
    const choice = await vscode.window.showInformationMessage(
      `Pairing token: ${handle.current?.token}    (port ${port})`,
      'Copy token',
      'Copy token and port',
    );
    if (choice === 'Copy token') {
      await vscode.env.clipboard.writeText(handle.current?.token ?? '');
    } else if (choice === 'Copy token and port') {
      await vscode.env.clipboard.writeText(`${handle.current?.token} ${port}`);
    }
  });

  register('explorerLink.refresh', () => {
    tree.refresh();
    properties.refresh();
  });

  /** Opens the read-only mirror of a script's source, straight from Studio. */
  async function openReadOnly(ref: string, node: { path: string; className: string }): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uriFor(node.path, node.className, ref));
    // The .lua suffix normally settles this, but set it explicitly so a workspace with
    // an unusual file association still gets Lua highlighting.
    await vscode.languages.setTextDocumentLanguage(document, 'lua').then(undefined, () => undefined);
    await vscode.window.showTextDocument(document, { preview: true });
  }

  register('explorerLink.openScript', async (ref?: string) => {
    const target = ref ?? treeView.selection[0];
    if (!target) {
      return;
    }
    const node = tree.node(target);
    if (!node?.flags?.script) {
      return;
    }

    // If Roblox's Script Sync has this script on disk, that file is the better thing to
    // open by a mile: it is editable, the language server sees it, and git tracks it.
    // The read-only mirror is the fallback for anything not synced.
    if (config().get<boolean>('preferDiskFiles', true)) {
      const file = await syncMap.fileFor(node);
      if (file) {
        const document = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(document, { preview: true });
        return;
      }
    }

    await openReadOnly(target, node);
  });

  register('explorerLink.openReadOnly', async (ref?: string) => {
    const target = ref ?? treeView.selection[0];
    const node = target ? tree.node(target) : undefined;
    if (target && node?.flags?.script) {
      await openReadOnly(target, node);
    }
  });

  register('explorerLink.revealFile', async (ref?: string) => {
    const target = ref ?? treeView.selection[0];
    const node = target ? tree.node(target) : undefined;
    if (!node) {
      return;
    }
    const file = await syncMap.fileFor(node);
    if (!file) {
      vscode.window.showInformationMessage(
        `Explorer Link: no synced file found for ${node.name}. In Studio, right-click an ancestor and choose "Sync to…".`,
      );
      return;
    }
    await vscode.commands.executeCommand('revealInExplorer', file);
  });

  register('explorerLink.rescanSyncedFiles', async () => {
    syncMap.invalidate();
    tree.refresh();
    vscode.window.showInformationMessage('Explorer Link: rescanning for synced files.');
  });

  register('explorerLink.setUpGit', () => setUpGit(output));

  register('explorerLink.openPreviewInEditor', () => {
    preview.openInEditor();
    const ref = treeView.selection[0];
    void preview.show(ref, ref ? tree.node(ref) : undefined);
  });

  register('explorerLink.refreshPreview', () => {
    const ref = treeView.selection[0];
    void preview.show(ref, ref ? tree.node(ref) : undefined);
  });

  // -- property copying -----------------------------------------------------

  const copied = (what: string) => vscode.window.setStatusBarMessage(`Copied ${what}`, 1500);

  register('explorerLink.copyPropertyValue', async (element?: PropertyElement) => {
    if (element?.kind === 'row') {
      await vscode.env.clipboard.writeText(element.row.value);
      copied(`${element.row.key} value`);
    } else if (element?.kind === 'group') {
      await vscode.env.clipboard.writeText(PropertiesProvider.groupAsText(element.group));
      copied(`${element.group.name} group`);
    }
  });

  register('explorerLink.copyPropertyName', async (element?: PropertyElement) => {
    if (element?.kind === 'row') {
      await vscode.env.clipboard.writeText(element.row.key);
      copied('property name');
    }
  });

  register('explorerLink.copyPropertyPair', async (element?: PropertyElement) => {
    if (element?.kind === 'row') {
      await vscode.env.clipboard.writeText(`${element.row.key} = ${element.row.value}`);
      copied(`${element.row.key}`);
    }
  });

  register('explorerLink.copyAllProperties', async () => {
    const text = properties.asText();
    if (!text) {
      vscode.window.showInformationMessage('Explorer Link: no properties to copy.');
      return;
    }
    await vscode.env.clipboard.writeText(text);
    copied('all properties');
  });

  register('explorerLink.revealInStudio', async (ref?: string) => {
    const target = ref ?? treeView.selection[0];
    if (!target) {
      return;
    }
    try {
      await handle.current.send('revealInStudio', { ref: target });
    } catch (error) {
      vscode.window.showWarningMessage(`Explorer Link: ${String(error)}`);
    }
  });

  register('explorerLink.copyPath', async (ref?: string) => {
    const target = ref ?? treeView.selection[0];
    const node = target ? tree.node(target) : undefined;
    if (node) {
      await vscode.env.clipboard.writeText(node.path);
    }
  });

  register('explorerLink.goToPath', async () => {
    if (!handle.current?.isConnected) {
      vscode.window.showInformationMessage('Explorer Link: no Studio session is connected.');
      return;
    }
    const input = await vscode.window.showInputBox({
      title: 'Go to Path',
      prompt: 'Path to reveal, e.g. game.ReplicatedStorage.Modules.Combat',
      value: 'game.',
      valueSelection: [5, 5],
    });
    if (!input) {
      return;
    }
    const segments = input
      .split('.')
      .map((segment) => segment.trim())
      .filter((segment, index) => segment.length > 0 && !(index === 0 && segment.toLowerCase() === 'game'));
    const ref = await tree.refForPath(segments);
    if (!ref) {
      vscode.window.showWarningMessage(`Explorer Link: nothing at ${input}`);
      return;
    }
    await treeView.reveal(ref, { select: true, focus: true, expand: true });
  });

  register('explorerLink.restartServer', () => restartServer());

  register('explorerLink.openWalkthrough', async () => {
    const guide = vscode.Uri.file(path.join(context.extensionPath, 'media', 'setup.md'));
    await vscode.commands.executeCommand('markdown.showPreview', guide);
  });

  // -- config changes -------------------------------------------------------

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (change) => {
      if (
        change.affectsConfiguration('explorerLink.port') ||
        change.affectsConfiguration('explorerLink.holdMs')
      ) {
        await restartServer();
      }
      if (change.affectsConfiguration('explorerLink.showClassNames')) {
        tree.refresh();
      }
    }),
  );

  await startServer();
}

export async function deactivate(): Promise<void> {
  await handle.current?.stop();
}

/**
 * Turns the folder Script Sync writes into a git repository.
 *
 * There is nothing Roblox-specific about this once the files exist — that is rather the
 * point. Script Sync puts real .luau files on disk; from there it is an ordinary repo
 * and VS Code's own Source Control panel does the rest. This command exists only so
 * that the first two minutes of it are not a trip to the terminal.
 */
const GITIGNORE = `# Roblox
*.rbxl
*.rbxlx
*.rbxl.lock
*.rbxlx.lock
*.rbxm
*.rbxmx

# Editors
.DS_Store
.vscode/settings.json

# Tooling
node_modules/
`;

async function setUpGit(output: vscode.OutputChannel): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'Explorer Link: open the folder you synced from Studio first, then run this again.',
      'Open Folder…',
    );
    if (choice) {
      await vscode.commands.executeCommand('vscode.openFolder');
    }
    return;
  }

  let folder = folders[0];
  if (folders.length > 1) {
    const picked = await vscode.window.showQuickPick(
      folders.map((candidate) => ({ label: candidate.name, description: candidate.uri.fsPath, folder: candidate })),
      { title: 'Which folder holds your synced scripts?' },
    );
    if (!picked) {
      return;
    }
    folder = picked.folder;
  }

  const root = folder.uri.fsPath;

  if (fs.existsSync(path.join(root, '.git'))) {
    vscode.window.showInformationMessage(`Explorer Link: ${folder.name} is already a git repository.`);
    await vscode.commands.executeCommand('workbench.view.scm');
    return;
  }

  const gitignore = path.join(root, '.gitignore');
  if (!fs.existsSync(gitignore)) {
    try {
      fs.writeFileSync(gitignore, GITIGNORE, 'utf8');
      output.appendLine(`wrote ${gitignore}`);
    } catch (error) {
      output.appendLine(`could not write .gitignore: ${String(error)}`);
    }
  }

  // Hand off to the built-in git extension rather than shelling out: it knows where
  // git lives on this machine and surfaces its own errors properly.
  try {
    await vscode.commands.executeCommand('git.init', folder.uri, true);
  } catch (error) {
    vscode.window.showErrorMessage(
      `Explorer Link: could not initialise a repository (${String(error)}). Is the built-in Git extension enabled?`,
    );
    return;
  }

  await vscode.commands.executeCommand('workbench.view.scm');
  vscode.window.showInformationMessage(
    `Explorer Link: ${folder.name} is now a git repo with a Roblox .gitignore. Stage and commit in the Source Control panel, then use "Publish Branch" to put it on GitHub.`,
  );
}
