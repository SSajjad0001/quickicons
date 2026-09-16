import * as vscode from "vscode";
import { isImageUri, previewDataUri, readConfig } from "./mediaUtils";

/**
 * Sidebar preview panel for the selected / opened icon (SVG or raster).
 */
export class PreviewViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "quickicons.preview";

  private view?: vscode.WebviewView;
  private currentUri?: vscode.Uri;

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: false,
      localResourceRoots: [],
    };
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

    const name = uri.path.split("/").pop() ?? "icon";
    this.view.description = name;
    this.view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html, body {
      margin: 0; padding: 0; height: 100%;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
    }
    .wrap {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 12px; min-height: 100%; padding: 16px; box-sizing: border-box;
    }
    .card {
      display: flex; align-items: center; justify-content: center;
      padding: 16px; border-radius: 10px;
      border: 1px solid var(--vscode-widget-border, transparent);
      background: var(--vscode-editor-background);
    }
    img { width: ${size}px; height: ${size}px; object-fit: contain; }
    .name { font-size: 12px; opacity: 0.85; word-break: break-all; text-align: center; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card"><img src="${dataUri}" alt="${escapeHtml(name)}" /></div>
    <div class="name">${escapeHtml(name)}</div>
  </div>
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
