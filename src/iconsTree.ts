import * as path from "path";
import * as vscode from "vscode";
import {
  getExt,
  listImagesInFolder,
  previewDataUri,
  readConfig,
  type ImageEntry,
} from "./mediaUtils";

export type IconNode = ImageEntry;

/**
 * Icon browser: lists every SVG/PNG/JPEG/… in the selected folder
 * (and subfolders). Same name with different formats appear as separate rows.
 */
export class IconsTreeProvider
  implements vscode.TreeDataProvider<IconNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<IconNode | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private folder?: vscode.Uri;
  private treeView?: vscode.TreeView<IconNode>;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly tooltipCache = new Map<string, vscode.MarkdownString>();
  private cachedNodes: IconNode[] = [];

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  bindTreeView(treeView: vscode.TreeView<IconNode>): void {
    this.treeView = treeView;
  }

  get currentFolder(): vscode.Uri | undefined {
    return this.folder;
  }

  get lastCount(): number {
    return this.cachedNodes.length;
  }

  refresh(): void {
    this.tooltipCache.clear();
    this._onDidChangeTreeData.fire();
  }

  setFolder(folder: vscode.Uri): void {
    this.folder = folder;
    this.tooltipCache.clear();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: IconNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
    // Unique per file path so foo.svg and foo.png never collapse into one row
    item.id = element.uri.fsPath;
    item.resourceUri = element.uri;

    // Tree icons: SVG/PNG work reliably as iconPath; other formats still list
    const ext = element.ext || getExt(element.name);
    if (ext === ".svg" || ext === ".png" || ext === ".gif" || ext === ".ico") {
      item.iconPath = element.uri;
    } else {
      item.iconPath = new vscode.ThemeIcon("file-media");
    }

    const format = ext.replace(".", "").toUpperCase();
    const nested = element.relativePath.includes("/");
    item.description = nested
      ? `${format} · ${path.posix.dirname(element.relativePath)}`
      : format;

    item.contextValue = "quickicons.icon";
    item.tooltip = this.buildTooltip(element);
    item.command = {
      command: "quickicons.pickIcon",
      title: "Preview",
      arguments: [element.uri],
    };
    return item;
  }

  resolveTreeItem(
    item: vscode.TreeItem,
    element: IconNode,
    _token: vscode.CancellationToken
  ): vscode.TreeItem {
    item.tooltip = this.buildTooltip(element);
    return item;
  }

  getChildren(element?: IconNode): IconNode[] {
    if (element || !this.folder) {
      return [];
    }

    const cfg = readConfig();
    this.cachedNodes = listImagesInFolder(this.folder.fsPath, {
      recursive: cfg.recursive,
      maxDepth: cfg.maxDepth,
    });

    if (this.treeView) {
      const folderName = path.basename(this.folder.fsPath);
      this.treeView.message =
        this.cachedNodes.length === 0
          ? `No icons found in “${folderName}” (svg, png, jpg, …)`
          : `${this.cachedNodes.length} icons in “${folderName}”`;
    }

    return this.cachedNodes;
  }

  private buildTooltip(element: IconNode): vscode.MarkdownString {
    const cached = this.tooltipCache.get(element.uri.fsPath);
    if (cached) {
      return cached;
    }

    const cfg = readConfig();
    const size = Math.max(cfg.previewSize, 80);
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = true;

    const dataUri = previewDataUri(element.uri.fsPath, size, cfg.background);
    if (!dataUri) {
      md.appendText(`${element.name}\n(preview unavailable)`);
      this.tooltipCache.set(element.uri.fsPath, md);
      return md;
    }

    const format = (element.ext || getExt(element.name)).replace(".", "").toUpperCase();
    md.appendMarkdown(
      `<div style="padding:4px 2px;">` +
        `<img src="${dataUri}" width="${size}" height="${size}" alt="${escapeAttr(element.name)}" style="object-fit:contain;" />` +
        `<div style="margin-top:6px;opacity:0.8;"><code>${escapeAttr(element.name)}</code> · ${format}</div>` +
        `</div>`
    );

    this.tooltipCache.set(element.uri.fsPath, md);
    return md;
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
