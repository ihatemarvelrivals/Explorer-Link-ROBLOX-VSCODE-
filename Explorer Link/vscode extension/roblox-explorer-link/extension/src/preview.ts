/**
 * The 3D preview view.
 *
 * Asks the plugin for a selected instance's geometry — primitive shape, size, CFrame,
 * colour, transparency per BasePart — and hands it to a webview that draws it with a
 * small hand-written WebGL renderer (media/preview.js).
 *
 * What it cannot do is show real mesh geometry: `MeshId` is an asset reference, and no
 * plugin API turns it into vertices. Meshes and unions therefore arrive flagged
 * `approximate`, get drawn as their true bounding box, and are counted in the header so
 * the number is visible rather than implied.
 *
 * It renders into two possible homes: the sidebar view, and an editor tab opened by
 * `Explorer Link: Open 3D Preview in Editor`. Both are fed by the same `show()`, so
 * whichever is open stays in step with the tree selection — and the editor tab works
 * even where the sidebar view will not register, which is the reason it exists.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { GetGeometryResult, RbxNode } from './protocol';
import { ServerHandle } from './server';

/** Above this the payload and the draw-call count stop being worth it for a preview. */
const MAX_PARTS = 400;

export class PreviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'explorerLink.preview';

  private view: vscode.WebviewView | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private currentRef: string | undefined;
  private currentNode: RbxNode | undefined;
  private requestToken = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handle: ServerHandle,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.prepare(view.webview);

    // The view is only built when the user first reveals it, so whatever was selected
    // before that still needs drawing.
    void this.show(this.currentRef, this.currentNode);
  }

  /** Shared setup for either home: options, HTML, and the message channel back. */
  private prepare(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webview.html = this.html(webview);
    webview.onDidReceiveMessage((message) => {
      if (message?.type === 'refresh' || message?.type === 'ready') {
        void this.show(this.currentRef, this.currentNode);
      }
    });
  }

  /**
   * Opens the preview as an editor tab. Independent of the sidebar view entirely, which
   * makes it both the roomier way to look at a model and the fallback when the sidebar
   * view does not show up.
   */
  openInEditor(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      void this.show(this.currentRef, this.currentNode);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'explorerLink.previewPanel',
      '3D Preview',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
      },
    );
    this.prepare(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    void this.show(this.currentRef, this.currentNode);
  }

  /** Every webview currently showing the preview — none, one, or both. */
  private webviews(): vscode.Webview[] {
    const out: vscode.Webview[] = [];
    if (this.view) {
      out.push(this.view.webview);
    }
    if (this.panel) {
      out.push(this.panel.webview);
    }
    return out;
  }

  /** True when this node is something the preview can draw at all. */
  static canPreview(node: RbxNode | undefined): boolean {
    if (!node) {
      return false;
    }
    return node.tags?.some((tag) => tag === 'BasePart' || tag === 'Model' || tag === 'PVInstance') ?? false;
  }

  async show(ref: string | undefined, node: RbxNode | undefined): Promise<void> {
    this.currentRef = ref;
    this.currentNode = node;

    const targets = this.webviews();
    if (targets.length === 0) {
      return;
    }

    // Selections move faster than round trips finish; a late answer for a node the user
    // has already moved off must not overwrite the current one.
    const token = ++this.requestToken;
    const post = (message: unknown) => {
      if (token !== this.requestToken) {
        return;
      }
      for (const webview of this.webviews()) {
        void webview.postMessage(message);
      }
    };

    if (!this.handle.current?.isConnected) {
      post({ type: 'empty', text: 'No Studio session is connected.' });
      return;
    }
    if (!ref || !node) {
      post({ type: 'empty', text: 'Select a part or model in the Explorer to preview it.' });
      return;
    }
    if (!PreviewProvider.canPreview(node)) {
      post({
        type: 'empty',
        heading: node.name,
        text: `${node.className} has no 3D geometry. Select a Part, MeshPart, Model or anything else with a physical shape.`,
      });
      return;
    }

    try {
      const result = await this.handle.current.send<GetGeometryResult>('getGeometry', {
        ref,
        maxParts: MAX_PARTS,
      });
      if (!result.parts || result.parts.length === 0) {
        post({
          type: 'empty',
          heading: node.name,
          text: `${node.name} contains no parts to draw.`,
        });
        return;
      }
      post({ type: 'model', model: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      post({
        type: 'empty',
        heading: node.name,
        text: message.includes('stale-ref')
          ? 'That instance no longer exists in the open place.'
          : `Could not read geometry (${message}).`,
      });
    }
  }

  clear(): void {
    this.currentRef = undefined;
    this.currentNode = undefined;
    this.requestToken += 1;
    for (const webview of this.webviews()) {
      void webview.postMessage({ type: 'empty', text: 'No Studio session is connected.' });
    }
  }

  /** True when the panel or the sidebar view is actually on screen. */
  get hasHome(): boolean {
    return this.view !== undefined || this.panel !== undefined;
  }

  private html(webview: vscode.Webview): string {
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'preview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'preview.css'));

    // A nonce rather than 'unsafe-inline': the renderer is a real file, and nothing in
    // this view should be able to run injected script.
    const nonce = Buffer.from(
      String(Date.now()) + String(Math.random()),
    ).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
<title>3D Preview</title>
</head>
<body>
  <div id="wrap">
    <div id="bar">
      <span id="heading"></span>
      <span id="detail"></span>
      <span id="badge" hidden></span>
      <span class="actions">
        <button id="frame" title="Fit the model in view (or double-click the canvas)">Fit</button>
      </span>
    </div>
    <canvas id="stage" hidden></canvas>
    <div id="empty">Select a part or model in the Explorer to preview it.</div>
    <div id="hint">drag to orbit · shift-drag to pan · scroll to zoom</div>
  </div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

/** Sanity check used by the extension at activation, so a missing asset is loud. */
export function previewAssetsPresent(extensionPath: string): boolean {
  return (
    fs.existsSync(path.join(extensionPath, 'media', 'preview.js')) &&
    fs.existsSync(path.join(extensionPath, 'media', 'preview.css'))
  );
}
