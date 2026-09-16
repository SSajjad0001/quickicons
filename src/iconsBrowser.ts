import * as path from "path";
import * as vscode from "vscode";
import {
  listImagesInFolder,
  readConfig,
  type ImageEntry,
} from "./mediaUtils";

const MIN_QUERY_LEN = 2;

type IconPayload = {
  path: string;
  name: string;
  relativePath: string;
  ext: string;
  format: string;
};

/**
 * Icons browser webview: search box under the ICONS header.
 * Matches typed text against the filename only (case-insensitive).
 * Filtering starts at 2 characters.
 */
export class IconsBrowserViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = "quickicons.icons";

  private view?: vscode.WebviewView;
  private folder?: vscode.Uri;
  private allIcons: IconPayload[] = [];
  private query = "";
  private readonly disposables: vscode.Disposable[] = [];
  private onPick?: (uri: vscode.Uri) => void;

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  setPickHandler(handler: (uri: vscode.Uri) => void): void {
    this.onPick = handler;
  }

  get currentFolder(): vscode.Uri | undefined {
    return this.folder;
  }

  get lastCount(): number {
    return this.allIcons.length;
  }

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
      (msg: { type: string; query?: string; path?: string }) => {
        if (msg.type === "search") {
          this.query = (msg.query ?? "").trim();
          this.updateDescription();
          return;
        }
        if (msg.type === "pick" && msg.path) {
          this.onPick?.(vscode.Uri.file(msg.path));
          return;
        }
        if (msg.type === "ready") {
          this.pushState();
        }
      },
      undefined,
      this.disposables
    );

    webviewView.webview.html = this.buildHtml();
    this.pushState();
  }

  setFolder(folder: vscode.Uri): void {
    this.folder = folder;
    this.query = "";
    this.reloadIcons();
    this.pushState();
  }

  refresh(): void {
    this.reloadIcons();
    this.pushState();
  }

  focusSearch(): void {
    void this.view?.webview.postMessage({ type: "focusSearch" });
  }

  private reloadIcons(): void {
    if (!this.folder) {
      this.allIcons = [];
      return;
    }
    const cfg = readConfig();
    const entries = listImagesInFolder(this.folder.fsPath, {
      recursive: cfg.recursive,
      maxDepth: cfg.maxDepth,
    });
    this.allIcons = entries.map(toPayload);
  }

  /** Filename-only, case-insensitive substring match */
  private filteredIcons(): IconPayload[] {
    return filterByFileName(this.allIcons, this.query);
  }

  private pushState(): void {
    if (!this.view) {
      return;
    }
    const folderName = this.folder ? path.basename(this.folder.fsPath) : "";
    // Send the full list — the webview filters by filename locally while typing
    this.view.webview.postMessage({
      type: "state",
      folderName,
      query: this.query,
      total: this.allIcons.length,
      icons: this.allIcons,
      minQuery: MIN_QUERY_LEN,
    });
    this.updateDescription();
  }

  private updateDescription(): void {
    if (!this.view) {
      return;
    }
    if (!this.folder) {
      this.view.description = undefined;
      return;
    }
    const total = this.allIcons.length;
    const shown = this.filteredIcons().length;
    if (this.query.length >= MIN_QUERY_LEN) {
      this.view.description = `${shown}/${total}`;
    } else {
      this.view.description = `${total}`;
    }
  }

  private buildHtml(): string {
    const nonce = String(Date.now());
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { color-scheme: light dark; }
    html, body {
      margin: 0; padding: 0; height: 100%;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-sideBar-foreground);
      background: var(--vscode-sideBar-background);
    }
    .wrap { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
    .search-row {
      display: flex; align-items: center; gap: 6px;
      padding: 8px 10px 6px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-widget-border, transparent));
      position: sticky; top: 0; background: var(--vscode-sideBar-background); z-index: 2;
    }
    .search-row input {
      flex: 1; min-width: 0; height: 24px; padding: 0 8px; border-radius: 2px;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background); color: var(--vscode-input-foreground); outline: none;
    }
    .search-row input:focus { border-color: var(--vscode-focusBorder); }
    .meta { padding: 4px 10px 6px; font-size: 11px; opacity: 0.75; }
    .list { flex: 1; overflow: auto; padding: 0 0 8px; }
    .row {
      display: flex; align-items: center; gap: 8px; padding: 4px 10px; cursor: pointer;
      border: none; background: transparent; width: 100%; text-align: left; color: inherit; font: inherit; box-sizing: border-box;
    }
    .row:hover, .row:focus { background: var(--vscode-list-hoverBackground); outline: none; }
    .row.active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .thumb {
      width: 20px; height: 20px; flex-shrink: 0; border-radius: 2px;
      background: var(--vscode-editor-background);
      display: flex; align-items: center; justify-content: center;
      font-size: 9px; opacity: 0.7;
      border: 1px solid var(--vscode-widget-border, transparent);
    }
    .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .name mark {
      background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,.3));
      color: inherit; border-radius: 2px; padding: 0 1px;
    }
    .format { flex-shrink: 0; font-size: 10px; opacity: 0.7; }
    .empty { padding: 16px 12px; opacity: 0.7; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="search-row">
      <input id="q" type="search" placeholder="Filter by filename (2+ chars)…" spellcheck="false" autocomplete="off" />
    </div>
    <div id="meta" class="meta"></div>
    <div id="list" class="list"></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const input = document.getElementById('q');
    const listEl = document.getElementById('list');
    const metaEl = document.getElementById('meta');

    let allIcons = [];
    let folderName = '';
    let activePath = '';
    let minQuery = ${MIN_QUERY_LEN};

    function normalizeQuery(value) {
      return String(value || '').trim().toLowerCase();
    }

    /** Match typed text against file name only (case-insensitive). */
    function matchesFileName(icon, q) {
      if (!q || q.length < minQuery) return true;
      return String(icon.name || '').toLowerCase().includes(q);
    }

    function filterIcons(q) {
      if (!q || q.length < minQuery) return allIcons;
      return allIcons.filter((icon) => matchesFileName(icon, q));
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function highlightName(name, q) {
      const safe = escapeHtml(name);
      if (!q || q.length < minQuery) return safe;
      const lower = name.toLowerCase();
      const idx = lower.indexOf(q);
      if (idx < 0) return safe;
      const before = escapeHtml(name.slice(0, idx));
      const mid = escapeHtml(name.slice(idx, idx + q.length));
      const after = escapeHtml(name.slice(idx + q.length));
      return before + '<mark>' + mid + '</mark>' + after;
    }

    function render() {
      const q = normalizeQuery(input.value);
      const icons = filterIcons(q);
      const total = allIcons.length;

      if (!total && !folderName) {
        metaEl.textContent = 'Select a folder, then Shift+Q I (or Browse Icons Here).';
        listEl.innerHTML = '';
        return;
      }

      if (q.length >= minQuery) {
        metaEl.textContent = icons.length + ' of ' + total + ' icons'
          + (folderName ? ' in “' + folderName + '”' : '')
          + ' · “' + input.value.trim() + '”';
      } else {
        metaEl.textContent = total + ' icons'
          + (folderName ? ' in “' + folderName + '”' : '')
          + (q ? ' · type ' + minQuery + '+ chars to filter' : '');
      }

      // Keep extension description in sync
      vscode.postMessage({ type: 'search', query: input.value });

      if (!icons.length) {
        listEl.innerHTML = '<div class="empty">No filenames match “' + escapeHtml(input.value.trim()) + '”.</div>';
        return;
      }

      const frag = document.createDocumentFragment();
      for (const icon of icons) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'row' + (icon.path === activePath ? ' active' : '');
        btn.title = icon.relativePath;

        const thumb = document.createElement('div');
        thumb.className = 'thumb';
        thumb.textContent = icon.format.slice(0, 3);
        btn.appendChild(thumb);

        const name = document.createElement('span');
        name.className = 'name';
        name.innerHTML = highlightName(icon.name, q);
        btn.appendChild(name);

        const format = document.createElement('span');
        format.className = 'format';
        format.textContent = icon.format;
        btn.appendChild(format);

        btn.addEventListener('click', () => {
          activePath = icon.path;
          for (const el of listEl.querySelectorAll('.row')) el.classList.remove('active');
          btn.classList.add('active');
          vscode.postMessage({ type: 'pick', path: icon.path });
        });
        btn.addEventListener('mouseenter', () => {
          vscode.postMessage({ type: 'pick', path: icon.path });
        });

        frag.appendChild(btn);
      }
      listEl.innerHTML = '';
      listEl.appendChild(frag);
    }

    input.addEventListener('input', () => render());

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'focusSearch') {
        input.focus();
        input.select();
        return;
      }
      if (msg.type === 'state') {
        allIcons = Array.isArray(msg.icons) ? msg.icons : [];
        folderName = msg.folderName || '';
        if (typeof msg.minQuery === 'number') minQuery = msg.minQuery;
        if (typeof msg.query === 'string' && document.activeElement !== input) {
          input.value = msg.query;
        }
        render();
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

/** Filename-only, case-insensitive substring match (shared with description count). */
export function filterByFileName(icons: IconPayload[], query: string): IconPayload[] {
  const q = query.trim().toLowerCase();
  if (q.length < MIN_QUERY_LEN) {
    return icons;
  }
  return icons.filter((icon) => icon.name.toLowerCase().includes(q));
}

function toPayload(entry: ImageEntry): IconPayload {
  return {
    path: entry.uri.fsPath,
    name: entry.name,
    relativePath: entry.relativePath,
    ext: entry.ext,
    format: entry.ext.replace(".", "").toUpperCase(),
  };
}
