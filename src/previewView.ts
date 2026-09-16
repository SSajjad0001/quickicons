import * as path from "path";
import * as vscode from "vscode";
import { isImageUri, isSvgPath, previewDataUri, readConfig } from "./mediaUtils";

/**
 * Sidebar preview panel for the selected / opened icon (SVG or raster).
 * Shows the image, file name, full path, and open actions.
 */
export class PreviewViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "quickicons.preview";

  private view?: vscode.WebviewView;
  private currentUri?: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };

    webviewView.webview.onDidReceiveMessage(
      async (msg: { type: string; path?: string }) => {
        const targetPath = msg.path || this.currentUri?.fsPath;
        if (!targetPath) {
          return;
        }
        const uri = vscode.Uri.file(targetPath);

        if (msg.type === "open") {
          if (isSvgPath(targetPath)) {
            await vscode.window.showTextDocument(uri, { preview: true });
          } else {
            await vscode.commands.executeCommand("vscode.open", uri);
          }
          return;
        }

        if (msg.type === "reveal") {
          await vscode.commands.executeCommand("revealInExplorer", uri);
          return;
        }

        if (msg.type === "copyPath") {
          await vscode.env.clipboard.writeText(targetPath);
          vscode.window.setStatusBarMessage("QuickIcons: path copied", 2000);
          return;
        }

        if (msg.type === "openFolder") {
          const folder = vscode.Uri.file(path.dirname(targetPath));
          await vscode.commands.executeCommand("revealFileInOS", folder);
        }
      },
      undefined,
      this.disposables
    );

    this.render(this.currentUri);
  }

  showUri(uri: vscode.Uri | undefined): void {
    this.currentUri = uri;
    this.render(uri);
  }

  private render(uri: vscode.Uri | undefined): void {
    if (!this.view) {
      return;
    }

    const cfg = readConfig();
    if (!cfg.enabled || !uri || !isImageUri(uri)) {
      this.view.webview.html = emptyHtml(
        "Select an icon (SVG, PNG, JPG, GIF, WebP, …) to preview."
      );
      this.view.description = undefined;
      return;
    }

    const size = Math.max(cfg.previewSize, 128);
    const dataUri = previewDataUri(uri.fsPath, size, cfg.background);
    if (!dataUri) {
      this.view.webview.html = emptyHtml("Could not read image file.");
      return;
    }

    const name = path.basename(uri.fsPath);
    const fullPath = uri.fsPath;
    const nonce = String(Date.now());

    this.view.description = name;
    this.view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html, body {
      margin: 0; padding: 0; height: 100%;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .wrap {
      display: flex; flex-direction: column; align-items: stretch;
      gap: 12px; min-height: 100%; padding: 14px; box-sizing: border-box;
    }
    .card {
      display: flex; align-items: center; justify-content: center;
      padding: 16px; border-radius: 10px; align-self: center;
      border: 1px solid var(--vscode-widget-border, transparent);
      background: var(--vscode-editor-background);
    }
    img { width: ${size}px; height: ${size}px; object-fit: contain; }
    .name {
      font-size: 13px; font-weight: 600; text-align: center; word-break: break-all;
    }
    .path {
      display: block;
      width: 100%;
      box-sizing: border-box;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      word-break: break-all;
      text-align: left;
      cursor: pointer;
      line-height: 1.35;
    }
    .path:hover { outline: 1px solid var(--vscode-focusBorder); }
    .hint { font-size: 10px; opacity: 0.65; text-align: center; }
    .actions {
      display: flex; flex-wrap: wrap; gap: 8px; justify-content: center;
    }
    button {
      cursor: pointer;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      padding: 5px 10px;
      border-radius: 4px;
      font: inherit;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button:hover { opacity: 0.92; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card"><img src="${dataUri}" alt="${escapeHtml(name)}" /></div>
    <div class="name">${escapeHtml(name)}</div>
    <button class="path" id="pathBtn" title="Click to copy path">${escapeHtml(fullPath)}</button>
    <div class="hint">Click path to copy · Open to edit/view file</div>
    <div class="actions">
      <button id="openBtn">Open</button>
      <button id="revealBtn" class="secondary">Reveal in Explorer</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const filePath = ${JSON.stringify(fullPath)};
    document.getElementById('openBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'open', path: filePath });
    });
    document.getElementById('revealBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'reveal', path: filePath });
    });
    document.getElementById('pathBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'copyPath', path: filePath });
    });
  </script>
</body>
</html>`;
  }
}

function emptyHtml(message: string): string {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:16px;font-family:var(--vscode-font-family);color:var(--vscode-descriptionForeground);">
  ${escapeHtml(message)}
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
