import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  listImagesInFolder,
  readConfig,
  type ImageEntry,
} from "./mediaUtils";
import {
  buildSvgFingerprint,
  scoreSvgSimilarity,
  type SvgFingerprint,
} from "./svgMatch";

const MIN_QUERY_LEN = 2;
const MIN_SVG_SCORE = 0.18;

type IconPayload = {
  path: string;
  name: string;
  relativePath: string;
  /** Path relative to the workspace root when available */
  workspaceRelativePath: string;
  ext: string;
  format: string;
  /** Webview-safe URI for the real icon thumbnail */
  thumb: string;
  score?: number;
};

/**
 * Icons browser webview: search + real icon thumbnails in the list.
 */
export class IconsBrowserViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = "quickicons.icons";

  private view?: vscode.WebviewView;
  private folder?: vscode.Uri;
  private allIcons: IconPayload[] = [];
  private svgFingerprints = new Map<string, SvgFingerprint>();
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
    this.applyResourceRoots();

    webviewView.webview.onDidReceiveMessage(
      async (msg: {
        type: string;
        query?: string;
        path?: string;
        text?: string;
        svg?: string;
      }) => {
        if (msg.type === "search") {
          this.query = (msg.query ?? "").trim();
          this.updateDescription();
          return;
        }
        if (msg.type === "svgSearch") {
          this.runSvgSearch(msg.svg ?? "");
          return;
        }
        if (msg.type === "pick" && msg.path) {
          this.onPick?.(vscode.Uri.file(msg.path));
          return;
        }
        if (msg.type === "open" && msg.path) {
          const uri = vscode.Uri.file(msg.path);
          const ext = path.extname(msg.path).toLowerCase();
          if (ext === ".svg") {
            await vscode.window.showTextDocument(uri, { preview: true });
          } else {
            await vscode.commands.executeCommand("vscode.open", uri);
          }
          return;
        }
        if (msg.type === "copyPath" && msg.text) {
          await vscode.env.clipboard.writeText(msg.text);
          vscode.window.setStatusBarMessage("QuickIcons: path copied", 2000);
          return;
        }
        if (msg.type === "copyRelativePath" && msg.text) {
          await vscode.env.clipboard.writeText(msg.text);
          vscode.window.setStatusBarMessage("QuickIcons: relative path copied", 2000);
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
    this.applyResourceRoots();
    this.reloadIcons();
    // Refresh html so CSP / webview state stays valid after roots change
    if (this.view) {
      this.view.webview.html = this.buildHtml();
    }
    this.pushState();
  }

  refresh(): void {
    this.applyResourceRoots();
    this.reloadIcons();
    this.pushState();
  }

  focusSearch(): void {
    void this.view?.webview.postMessage({ type: "focusSearch" });
  }

  private applyResourceRoots(): void {
    if (!this.view) {
      return;
    }
    const roots: vscode.Uri[] = [];
    if (this.folder) {
      roots.push(this.folder);
    }
    for (const wf of vscode.workspace.workspaceFolders ?? []) {
      roots.push(wf.uri);
    }
    this.view.webview.options = {
      enableScripts: true,
      localResourceRoots: roots,
    };
  }

  private reloadIcons(): void {
    if (!this.folder) {
      this.allIcons = [];
      this.svgFingerprints.clear();
      return;
    }
    const cfg = readConfig();
    const entries = listImagesInFolder(this.folder.fsPath, {
      recursive: cfg.recursive,
      maxDepth: cfg.maxDepth,
    });
    this.svgFingerprints.clear();
    this.allIcons = entries.map((e) => {
      const payload = this.toPayload(e);
      if (e.ext === ".svg") {
        try {
          const raw = fs.readFileSync(e.uri.fsPath, "utf8");
          const fp = buildSvgFingerprint(raw);
          if (fp) {
            this.svgFingerprints.set(e.uri.fsPath, fp);
          }
        } catch {
          // ignore unreadable svg
        }
      }
      return payload;
    });
  }

  private runSvgSearch(svgText: string): void {
    if (!this.view) {
      return;
    }
    const trimmed = svgText.trim();
    if (trimmed.length < 8) {
      this.view.webview.postMessage({
        type: "svgResults",
        total: this.allIcons.length,
        svgCount: this.svgFingerprints.size,
        icons: [],
        queryLen: trimmed.length,
      });
      this.view.description = `0/${this.svgFingerprints.size}`;
      return;
    }

    const queryFp = buildSvgFingerprint(trimmed);
    if (!queryFp) {
      this.view.webview.postMessage({
        type: "svgResults",
        total: this.allIcons.length,
        svgCount: this.svgFingerprints.size,
        icons: [],
        error: "Paste valid SVG markup (or a path fragment).",
      });
      return;
    }

    const scored: IconPayload[] = [];
    for (const icon of this.allIcons) {
      if (icon.ext !== ".svg") {
        continue;
      }
      const fp = this.svgFingerprints.get(icon.path);
      if (!fp) {
        continue;
      }
      const score = scoreSvgSimilarity(queryFp, fp);
      if (score >= MIN_SVG_SCORE) {
        scored.push({ ...icon, score });
      }
    }

    scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const top = scored.slice(0, 200);

    this.view.webview.postMessage({
      type: "svgResults",
      total: this.allIcons.length,
      svgCount: this.svgFingerprints.size,
      icons: top,
    });
    this.view.description = `${top.length}/${this.svgFingerprints.size}`;
  }

  private toPayload(entry: ImageEntry): IconPayload {
    const thumb = this.view
      ? this.view.webview.asWebviewUri(entry.uri).toString()
      : "";
    const workspaceRelativePath = vscode.workspace.asRelativePath(entry.uri, false);
    return {
      path: entry.uri.fsPath,
      name: entry.name,
      relativePath: entry.relativePath,
      workspaceRelativePath:
        workspaceRelativePath && workspaceRelativePath !== entry.uri.fsPath
          ? workspaceRelativePath.replace(/\\/g, "/")
          : entry.relativePath,
      ext: entry.ext,
      format: entry.ext.replace(".", "").toUpperCase(),
      thumb,
    };
  }

  private filteredIcons(): IconPayload[] {
    return filterByFileName(this.allIcons, this.query);
  }

  private pushState(): void {
    if (!this.view) {
      return;
    }
    const folderName = this.folder ? path.basename(this.folder.fsPath) : "";
    const cfg = readConfig();
    this.view.webview.postMessage({
      type: "state",
      folderName,
      query: this.query,
      total: this.allIcons.length,
      icons: this.allIcons,
      minQuery: MIN_QUERY_LEN,
      previewSize: Math.max(cfg.previewSize, 80),
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
    this.view.description =
      this.query.length >= MIN_QUERY_LEN ? `${shown}/${total}` : `${total}`;
  }

  private buildHtml(): string {
    const nonce = String(Date.now());
    const cspSource = this.view?.webview.cspSource ?? "";
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource} data: https:;" />
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
      display: flex; align-items: flex-start; gap: 6px;
      padding: 8px 10px 6px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-widget-border, transparent));
      position: sticky; top: 0; background: var(--vscode-sideBar-background); z-index: 2;
    }
    .search-fields { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
    .search-row input[type="search"],
    .search-row textarea {
      width: 100%; box-sizing: border-box;
      padding: 4px 8px; border-radius: 2px;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background); color: var(--vscode-input-foreground); outline: none;
      font: inherit;
    }
    .search-row input[type="search"] { height: 24px; }
    .search-row textarea {
      min-height: 72px; max-height: 160px; resize: vertical;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px; line-height: 1.35;
      display: none;
    }
    .search-row.svg-on input[type="search"] { display: none; }
    .search-row.svg-on textarea { display: block; }
    .search-row input:focus, .search-row textarea:focus { border-color: var(--vscode-focusBorder); }
    .svg-toggle {
      display: flex; align-items: center; gap: 4px;
      flex-shrink: 0; margin-top: 3px;
      font-size: 11px; user-select: none; cursor: pointer;
      opacity: 0.9; white-space: nowrap;
    }
    .svg-toggle input { margin: 0; cursor: pointer; }
    .score {
      flex-shrink: 0; font-size: 10px; opacity: 0.75;
      min-width: 34px; text-align: right;
    }
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
    .thumb-wrap {
      width: 22px; height: 22px; flex-shrink: 0; border-radius: 3px;
      background:
        linear-gradient(45deg, #80808020 25%, transparent 25%),
        linear-gradient(-45deg, #80808020 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, #80808020 75%),
        linear-gradient(-45deg, transparent 75%, #80808020 75%);
      background-size: 8px 8px;
      background-position: 0 0, 0 4px, 4px -4px, -4px 0;
      display: flex; align-items: center; justify-content: center;
      overflow: hidden;
      border: 1px solid var(--vscode-widget-border, transparent);
      cursor: zoom-in;
    }
    .thumb-wrap img {
      width: 20px; height: 20px; object-fit: contain; display: block;
    }
    .thumb-wrap .fallback {
      font-size: 8px; opacity: 0.7;
    }
    .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .name mark {
      background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,.3));
      color: inherit; border-radius: 2px; padding: 0 1px;
    }
    .format { flex-shrink: 0; font-size: 10px; opacity: 0.7; }
    .empty { padding: 16px 12px; opacity: 0.7; }

    /* Small hover preview modal */
    #hover-modal {
      position: fixed;
      z-index: 1000;
      display: none;
      pointer-events: none;
      padding: 10px;
      border-radius: 8px;
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.35));
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      box-shadow: 0 8px 24px rgba(0,0,0,.35);
      max-width: 220px;
    }
    #hover-modal.visible { display: block; }
    #hover-modal .preview-frame {
      width: var(--preview-size, 96px);
      height: var(--preview-size, 96px);
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      background:
        linear-gradient(45deg, #80808022 25%, transparent 25%),
        linear-gradient(-45deg, #80808022 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, #80808022 75%),
        linear-gradient(-45deg, transparent 75%, #80808022 75%);
      background-size: 12px 12px;
      background-position: 0 0, 0 6px, 6px -6px, -6px 0;
      overflow: hidden;
    }
    #hover-modal img {
      max-width: 100%;
      max-height: 100%;
      width: var(--preview-size, 96px);
      height: var(--preview-size, 96px);
      object-fit: contain;
      display: block;
    }
    #hover-modal .label {
      margin-top: 8px;
      font-size: 11px;
      text-align: center;
      word-break: break-all;
      opacity: 0.9;
    }
    #hover-modal .label .fn { font-weight: 600; margin-bottom: 4px; }
    #hover-modal .label .fp {
      font-size: 10px;
      opacity: 0.75;
      font-family: var(--vscode-editor-font-family, monospace);
      text-align: left;
    }
    #hover-modal { max-width: 280px; }

    /* Right-click context menu */
    #ctx-menu {
      position: fixed;
      z-index: 1100;
      display: none;
      min-width: 180px;
      padding: 4px 0;
      border-radius: 6px;
      border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, transparent));
      background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      box-shadow: 0 6px 18px rgba(0,0,0,.35);
    }
    #ctx-menu.visible { display: block; }
    #ctx-menu button {
      display: block;
      width: 100%;
      text-align: left;
      border: none;
      background: transparent;
      color: inherit;
      font: inherit;
      padding: 6px 14px;
      cursor: pointer;
    }
    #ctx-menu button:hover {
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
      color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="search-row" id="searchRow">
      <div class="search-fields">
        <input id="q" type="search" placeholder="Filter by filename (2+ chars)…" spellcheck="false" autocomplete="off" />
        <textarea id="svgQ" placeholder="Paste SVG code to find similar icons…" spellcheck="false"></textarea>
      </div>
      <label class="svg-toggle" title="Search by pasted SVG markup / path similarity">
        <input type="checkbox" id="svgMode" />
        <span>SVG</span>
      </label>
    </div>
    <div id="meta" class="meta"></div>
    <div id="list" class="list"></div>
  </div>
  <div id="hover-modal" aria-hidden="true">
    <div class="preview-frame"><img id="hover-img" alt="" /></div>
    <div class="label" id="hover-label"></div>
  </div>
  <div id="ctx-menu" role="menu" aria-hidden="true">
    <button type="button" data-action="open">Open</button>
    <button type="button" data-action="copyPath">Copy Path</button>
    <button type="button" data-action="copyRelativePath">Copy Relative Path</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const searchRow = document.getElementById('searchRow');
    const input = document.getElementById('q');
    const svgInput = document.getElementById('svgQ');
    const svgMode = document.getElementById('svgMode');
    const listEl = document.getElementById('list');
    const metaEl = document.getElementById('meta');
    const hoverModal = document.getElementById('hover-modal');
    const hoverImg = document.getElementById('hover-img');
    const hoverLabel = document.getElementById('hover-label');
    const ctxMenu = document.getElementById('ctx-menu');

    let allIcons = [];
    let displayIcons = null; // when set (SVG search), render this instead of filename filter
    let folderName = '';
    let activePath = '';
    let minQuery = ${MIN_QUERY_LEN};
    let previewSize = 96;
    let hideTimer;
    let ctxIcon = null;
    let svgDebounce;
    let svgCount = 0;

    function normalizeQuery(value) {
      return String(value || '').trim().toLowerCase();
    }

    function matchesFileName(icon, q) {
      if (!q || q.length < minQuery) return true;
      return String(icon.name || '').toLowerCase().includes(q);
    }

    function filterIcons(q) {
      if (!q || q.length < minQuery) return allIcons;
      return allIcons.filter((icon) => matchesFileName(icon, q));
    }

    function isSvgMode() {
      return !!(svgMode && svgMode.checked);
    }

    function syncSvgModeUi() {
      if (!searchRow) return;
      if (isSvgMode()) {
        searchRow.classList.add('svg-on');
        svgInput.focus();
      } else {
        searchRow.classList.remove('svg-on');
        clearTimeout(svgDebounce);
        displayIcons = null;
        input.focus();
        renderFilenameList();
      }
    }

    function requestSvgSearch() {
      if (!isSvgMode()) return;
      clearTimeout(svgDebounce);
      svgDebounce = setTimeout(() => {
        if (!isSvgMode()) return;
        vscode.postMessage({ type: 'svgSearch', svg: svgInput.value || '' });
      }, 180);
    }

    function renderFilenameList() {
      displayIcons = null;
      render({ mode: 'filename' });
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

    function showHover(icon, anchorEl) {
      clearTimeout(hideTimer);
      if (!icon || !icon.thumb) {
        hideHover();
        return;
      }
      document.documentElement.style.setProperty('--preview-size', previewSize + 'px');
      hoverImg.src = icon.thumb;
      hoverLabel.innerHTML = '<div class="fn">' + escapeHtml(icon.name) + '</div>'
        + '<div class="fp">' + escapeHtml(icon.path) + '</div>';
      hoverModal.classList.add('visible');
      hoverModal.setAttribute('aria-hidden', 'false');

      const rect = anchorEl.getBoundingClientRect();
      const modalW = hoverModal.offsetWidth || (previewSize + 24);
      const modalH = hoverModal.offsetHeight || (previewSize + 48);
      let left = rect.right + 10;
      let top = rect.top;

      if (left + modalW > window.innerWidth - 8) {
        left = Math.max(8, rect.left - modalW - 10);
      }
      if (top + modalH > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - modalH - 8);
      }
      if (top < 8) top = 8;

      hoverModal.style.left = left + 'px';
      hoverModal.style.top = top + 'px';
    }

    function hideHover() {
      hoverModal.classList.remove('visible');
      hoverModal.setAttribute('aria-hidden', 'true');
      hoverImg.removeAttribute('src');
    }

    function scheduleHideHover() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hideHover, 80);
    }

    function hideContextMenu() {
      ctxMenu.classList.remove('visible');
      ctxMenu.setAttribute('aria-hidden', 'true');
      ctxIcon = null;
    }

    function showContextMenu(icon, event) {
      event.preventDefault();
      event.stopPropagation();
      hideHover();
      ctxIcon = icon;
      ctxMenu.classList.add('visible');
      ctxMenu.setAttribute('aria-hidden', 'false');

      const menuW = ctxMenu.offsetWidth || 180;
      const menuH = ctxMenu.offsetHeight || 70;
      let left = event.clientX;
      let top = event.clientY;
      if (left + menuW > window.innerWidth - 6) left = window.innerWidth - menuW - 6;
      if (top + menuH > window.innerHeight - 6) top = window.innerHeight - menuH - 6;
      if (left < 6) left = 6;
      if (top < 6) top = 6;
      ctxMenu.style.left = left + 'px';
      ctxMenu.style.top = top + 'px';
    }

    ctxMenu.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn || !ctxIcon) return;
      const action = btn.getAttribute('data-action');
      if (action === 'open') {
        vscode.postMessage({ type: 'open', path: ctxIcon.path });
      } else if (action === 'copyPath') {
        vscode.postMessage({ type: 'copyPath', text: ctxIcon.path });
      } else if (action === 'copyRelativePath') {
        const rel = ctxIcon.workspaceRelativePath || ctxIcon.relativePath || ctxIcon.name;
        vscode.postMessage({ type: 'copyRelativePath', text: rel });
      }
      hideContextMenu();
    });

    document.addEventListener('click', () => hideContextMenu());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideContextMenu();
    });

    function makeThumb(icon) {
      const wrap = document.createElement('div');
      wrap.className = 'thumb-wrap';
      if (icon.thumb) {
        const img = document.createElement('img');
        img.src = icon.thumb;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.addEventListener('error', () => {
          wrap.textContent = '';
          const fb = document.createElement('span');
          fb.className = 'fallback';
          fb.textContent = icon.format.slice(0, 3);
          wrap.appendChild(fb);
        });
        wrap.appendChild(img);
      } else {
        const fb = document.createElement('span');
        fb.className = 'fallback';
        fb.textContent = icon.format.slice(0, 3);
        wrap.appendChild(fb);
      }
      return wrap;
    }

    function render(options) {
      const mode = (options && options.mode)
        || (isSvgMode() ? 'svg' : 'filename');
      const fromSvg = mode === 'svg';
      const q = normalizeQuery(input.value);

      // Filename mode always uses the full icon list (all formats)
      const icons = fromSvg && Array.isArray(displayIcons)
        ? displayIcons
        : filterIcons(q);

      const total = allIcons.length;
      hideHover();

      if (!total && !folderName) {
        metaEl.textContent = 'Select a folder, then Shift+Q I (or Browse Icons Here).';
        listEl.innerHTML = '';
        return;
      }

      if (fromSvg) {
        if (options && options.svgError) {
          metaEl.textContent = options.svgError;
        } else if (!svgInput.value.trim()) {
          metaEl.textContent = (svgCount || 0) + ' SVG icons ready — paste markup to find matches';
        } else {
          metaEl.textContent = icons.length + ' similar of ' + (svgCount || 0) + ' SVG'
            + (folderName ? ' in “' + folderName + '”' : '');
        }
      } else {
        // Always announce full library size when leaving SVG mode
        if (q.length >= minQuery) {
          metaEl.textContent = icons.length + ' of ' + total + ' icons'
            + (folderName ? ' in “' + folderName + '”' : '')
            + ' · “' + input.value.trim() + '”';
        } else {
          metaEl.textContent = total + ' icons'
            + (folderName ? ' in “' + folderName + '”' : '')
            + (q ? ' · type ' + minQuery + '+ chars to filter' : '');
        }
        vscode.postMessage({ type: 'search', query: input.value, resetSvg: true });
      }

      if (!icons.length) {
        const emptyMsg = fromSvg
          ? (svgInput.value.trim()
              ? 'No similar SVG icons found.'
              : 'Paste SVG code to search.')
          : 'No filenames match “' + escapeHtml(input.value.trim()) + '”.';
        listEl.innerHTML = '<div class="empty">' + emptyMsg + '</div>';
        return;
      }

      const frag = document.createDocumentFragment();
      for (const icon of icons) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'row' + (icon.path === activePath ? ' active' : '');

        const thumbEl = makeThumb(icon);
        thumbEl.addEventListener('mouseenter', () => {
          showHover(icon, thumbEl);
        });
        thumbEl.addEventListener('mouseleave', () => scheduleHideHover());
        btn.appendChild(thumbEl);

        const name = document.createElement('span');
        name.className = 'name';
        name.innerHTML = fromSvg ? escapeHtml(icon.name) : highlightName(icon.name, q);
        btn.appendChild(name);

        if (fromSvg && typeof icon.score === 'number') {
          const scoreEl = document.createElement('span');
          scoreEl.className = 'score';
          scoreEl.textContent = Math.round(icon.score * 100) + '%';
          scoreEl.title = 'Similarity score';
          btn.appendChild(scoreEl);
        }

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
          if (ctxMenu.classList.contains('visible')) return;
          vscode.postMessage({ type: 'pick', path: icon.path });
        });
        btn.addEventListener('contextmenu', (event) => showContextMenu(icon, event));

        frag.appendChild(btn);
      }
      listEl.innerHTML = '';
      listEl.appendChild(frag);
    }

    listEl.addEventListener('scroll', () => {
      hideHover();
      hideContextMenu();
    }, { passive: true });
    input.addEventListener('input', () => {
      if (!isSvgMode()) renderFilenameList();
    });
    svgMode.addEventListener('change', () => {
      if (isSvgMode()) {
        searchRow.classList.add('svg-on');
        clearTimeout(svgDebounce);
        displayIcons = [];
        svgInput.focus();
        render({ mode: 'svg' });
        if (svgInput.value.trim()) requestSvgSearch();
      } else {
        syncSvgModeUi();
      }
    });
    svgInput.addEventListener('input', () => {
      if (isSvgMode()) requestSvgSearch();
    });
    svgInput.addEventListener('paste', () => {
      if (isSvgMode()) {
        setTimeout(() => requestSvgSearch(), 0);
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'focusSearch') {
        if (isSvgMode()) {
          svgInput.focus();
          svgInput.select();
        } else {
          input.focus();
          input.select();
        }
        return;
      }
      if (msg.type === 'svgResults') {
        // Ignore late SVG results after unchecking
        if (!isSvgMode()) return;
        displayIcons = Array.isArray(msg.icons) ? msg.icons : [];
        if (typeof msg.svgCount === 'number') svgCount = msg.svgCount;
        render({ mode: 'svg', svgError: msg.error });
        return;
      }
      if (msg.type === 'state') {
        allIcons = Array.isArray(msg.icons) ? msg.icons : [];
        folderName = msg.folderName || '';
        svgCount = allIcons.filter((i) => i.ext === '.svg').length;
        displayIcons = null;
        if (typeof msg.minQuery === 'number') minQuery = msg.minQuery;
        if (typeof msg.previewSize === 'number') previewSize = msg.previewSize;
        if (typeof msg.query === 'string' && document.activeElement !== input) {
          input.value = msg.query;
        }
        if (isSvgMode() && svgInput.value.trim()) {
          requestSvgSearch();
        } else if (isSvgMode()) {
          displayIcons = [];
          render({ mode: 'svg' });
        } else {
          renderFilenameList();
        }
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

export function filterByFileName(icons: IconPayload[], query: string): IconPayload[] {
  const q = query.trim().toLowerCase();
  if (q.length < MIN_QUERY_LEN) {
    return icons;
  }
  return icons.filter((icon) => icon.name.toLowerCase().includes(q));
}
