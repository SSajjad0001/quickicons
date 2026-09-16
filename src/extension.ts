import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { IconHoverProvider } from "./hoverProvider";
import { IconsTreeProvider } from "./iconsTree";
import { isImageUri, isSvgUri, readConfig } from "./mediaUtils";
import { PreviewViewProvider } from "./previewView";

/**
 * Resolve the Explorer selection when the command is run via keybinding
 * (context menu already passes the uri).
 */
async function resolveExplorerTarget(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (uri?.scheme === "file") {
    return uri;
  }

  // Keybinding: read the focused Explorer resource via copyFilePath
  const previous = await vscode.env.clipboard.readText();
  try {
    await vscode.commands.executeCommand("copyFilePath");
    const copied = (await vscode.env.clipboard.readText()).trim();
    // Restore clipboard (best-effort)
    await vscode.env.clipboard.writeText(previous);

    // copyFilePath may return multiple lines when multi-select
    const first = copied.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && fs.existsSync(first)) {
      return vscode.Uri.file(first);
    }
  } catch {
    try {
      await vscode.env.clipboard.writeText(previous);
    } catch {
      // ignore
    }
  }

  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === "file") {
    return active;
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function toBrowseFolder(target: vscode.Uri): vscode.Uri {
  try {
    if (fs.existsSync(target.fsPath) && fs.statSync(target.fsPath).isDirectory()) {
      return target;
    }
  } catch {
    // fall through
  }
  return vscode.Uri.file(path.dirname(target.fsPath));
}

export function activate(context: vscode.ExtensionContext): void {
  try {
    const hoverProvider = new IconHoverProvider();
    const previewProvider = new PreviewViewProvider();
    const iconsTree = new IconsTreeProvider();

    const treeView = vscode.window.createTreeView("quickicons.icons", {
      treeDataProvider: iconsTree,
      showCollapseAll: false,
    });
    iconsTree.bindTreeView(treeView);

    context.subscriptions.push(
      vscode.languages.registerHoverProvider({ scheme: "file" }, hoverProvider),
      vscode.languages.registerHoverProvider({ scheme: "untitled" }, hoverProvider),
      vscode.window.registerWebviewViewProvider(PreviewViewProvider.viewId, previewProvider, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      treeView,
      iconsTree
    );

    context.subscriptions.push(
      treeView.onDidChangeSelection((e) => {
        const node = e.selection[0];
        if (node) {
          previewProvider.showUri(node.uri);
        }
      })
    );

    // Only update the side preview when an image is opened — do NOT replace the Icons list folder
    const syncFromEditor = (editor: vscode.TextEditor | undefined) => {
      const cfg = readConfig();
      if (!cfg.enabled || !cfg.autoPreview) {
        return;
      }
      const uri = editor?.document.uri;
      if (isImageUri(uri)) {
        previewProvider.showUri(uri);
      }
    };

    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(syncFromEditor),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (!isImageUri(doc.uri)) {
          return;
        }
        const folder = iconsTree.currentFolder?.fsPath;
        if (folder && doc.uri.fsPath.startsWith(folder)) {
          iconsTree.refresh();
        }
        if (vscode.window.activeTextEditor?.document.uri.fsPath === doc.uri.fsPath) {
          previewProvider.showUri(doc.uri);
        }
      })
    );

    syncFromEditor(vscode.window.activeTextEditor);

    context.subscriptions.push(
      vscode.commands.registerCommand("quickicons.toggle", async () => {
        const config = vscode.workspace.getConfiguration("quickicons");
        const enabled = config.get<boolean>("enabled", true);
        await config.update("enabled", !enabled, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
          `QuickIcons: ${!enabled ? "enabled" : "disabled"}`
        );
      }),
      vscode.commands.registerCommand("quickicons.showStatus", () => {
        vscode.window.showInformationMessage(
          "QuickIcons: Explorer → “Icons”, hover rows to preview SVG/PNG/JPG/…"
        );
      }),
      vscode.commands.registerCommand("quickicons.pickIcon", (uri: vscode.Uri) => {
        if (uri) {
          previewProvider.showUri(uri);
        }
      }),
      vscode.commands.registerCommand("quickicons.previewActive", () => {
        const uri = vscode.window.activeTextEditor?.document.uri;
        if (!isImageUri(uri)) {
          vscode.window.showWarningMessage("Open an image or SVG file first.");
          return;
        }
        previewProvider.showUri(uri);
        void vscode.commands.executeCommand("quickicons.preview.focus");
      }),
      vscode.commands.registerCommand("quickicons.refreshIcons", () => {
        iconsTree.refresh();
      }),
      vscode.commands.registerCommand(
        "quickicons.browseFolder",
        async (uri?: vscode.Uri, _uris?: vscode.Uri[]) => {
          const target = await resolveExplorerTarget(uri);
          if (!target) {
            vscode.window.showWarningMessage(
              "QuickIcons: select a folder in Explorer, then press Shift+Q then I."
            );
            return;
          }
          const folder = toBrowseFolder(target);
          iconsTree.setFolder(folder);
          await vscode.commands.executeCommand("quickicons.icons.focus");
          // Force a children refresh so the count message updates immediately
          iconsTree.refresh();
          vscode.window.setStatusBarMessage(
            `QuickIcons: ${path.basename(folder.fsPath)} — all SVG/PNG/JPEG/… listed in Icons`,
            4000
          );
        }
      ),
      vscode.commands.registerCommand(
        "quickicons.openIcon",
        async (node?: { uri?: vscode.Uri } | vscode.Uri) => {
          const target =
            (node && "fsPath" in node ? node : node && "uri" in node ? node.uri : undefined) ??
            treeView.selection[0]?.uri;
          if (!target) {
            return;
          }
          // Text SVGs; use default open for raster images
          if (isSvgUri(target)) {
            await vscode.window.showTextDocument(target, { preview: true, preserveFocus: true });
          } else {
            await vscode.commands.executeCommand("vscode.open", target);
          }
        }
      )
    );

    console.log("[QuickIcons] activated");
  } catch (err) {
    console.error("[QuickIcons] activation failed", err);
    void vscode.window.showErrorMessage(
      `QuickIcons failed to activate: ${err instanceof Error ? err.message : String(err)}`
    );
    throw err;
  }
}

export function deactivate(): void {
  // no-op
}
