import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  IMAGE_EXT_PATTERN,
  isImagePath,
  isSvgPath,
  isSvgUri,
  loadSvgFile,
  prepareSvg,
  previewDataUri,
  readConfig,
  toSvgDataUri,
  wrapForPreview,
  writePreviewFile,
  type BackgroundKind,
} from "./mediaUtils";

const IMAGE_PATH_RE = new RegExp(
  `(?:["'\`]|(?:url\\(\\s*["']?))((?:[^"'\`)\\s\\\\]|\\\\.)+\\.(?:${IMAGE_EXT_PATTERN}))(?:["'\`]|\\s*\\))?`,
  "gi"
);

export class IconHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Hover> {
    try {
      const cfg = readConfig();
      if (!cfg.enabled) {
        return undefined;
      }

      if (isSvgUri(document.uri)) {
        return this.hoverForSvgDocument(
          document,
          position,
          cfg.previewSize,
          cfg.showFileName,
          cfg.background
        );
      }

      const pathHit = this.findImagePathAtPosition(document, position);
      if (pathHit) {
        const resolved = resolveMediaPath(document, pathHit.path);
        if (resolved && fs.existsSync(resolved) && isImagePath(resolved)) {
          return buildFileHover(
            resolved,
            cfg.previewSize,
            cfg.background,
            cfg.showFileName ? path.basename(resolved) : undefined,
            pathHit.range
          );
        }
      }

      const inline = this.findInlineSvgAtPosition(document, position);
      if (inline) {
        return buildSvgHover(
          inline.svg,
          cfg.previewSize,
          cfg.background,
          "inline <svg>",
          inline.range
        );
      }
    } catch (err) {
      console.error("[QuickIcons] hover error", err);
    }

    return undefined;
  }

  private hoverForSvgDocument(
    document: vscode.TextDocument,
    position: vscode.Position,
    size: number,
    showFileName: boolean,
    background: BackgroundKind
  ): vscode.Hover | undefined {
    const text = document.getText();
    if (!/<svg[\s>]/i.test(text)) {
      return undefined;
    }

    const line = document.lineAt(position.line).text;
    const nearSvgTag = /<\/?svg\b/i.test(line) || document.lineCount <= 120;
    if (!nearSvgTag) {
      return undefined;
    }

    const range = document.lineAt(position.line).range;
    const label = showFileName ? path.basename(document.fileName) : undefined;
    return buildSvgHover(text, size, background, label, range);
  }

  private findImagePathAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): { path: string; range: vscode.Range } | undefined {
    const line = document.lineAt(position.line);
    const text = line.text;
    IMAGE_PATH_RE.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = IMAGE_PATH_RE.exec(text)) !== null) {
      const rel = match[1];
      const pathStart = text.indexOf(rel, match.index);
      const pathEnd = pathStart + rel.length;
      if (position.character >= pathStart && position.character <= pathEnd) {
        return {
          path: unescapePath(rel),
          range: new vscode.Range(position.line, pathStart, position.line, pathEnd),
        };
      }
    }

    const wordRange = document.getWordRangeAtPosition(
      position,
      new RegExp(`[^\\s"'\`()]+?\\.(?:${IMAGE_EXT_PATTERN})\\b`)
    );
    if (wordRange) {
      return {
        path: document.getText(wordRange),
        range: wordRange,
      };
    }

    return undefined;
  }

  private findInlineSvgAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): { svg: string; range: vscode.Range } | undefined {
    const offset = document.offsetAt(position);
    const text = document.getText();
    const openIdx = text.lastIndexOf("<svg", offset);
    if (openIdx < 0) {
      return undefined;
    }

    const closeIdx = text.indexOf("</svg>", openIdx);
    if (closeIdx < 0) {
      return undefined;
    }

    const end = closeIdx + "</svg>".length;
    if (offset < openIdx || offset > end) {
      return undefined;
    }

    if (end - openIdx > 100_000) {
      return undefined;
    }

    return {
      svg: text.slice(openIdx, end),
      range: new vscode.Range(document.positionAt(openIdx), document.positionAt(end)),
    };
  }
}

function buildFileHover(
  fsPath: string,
  size: number,
  background: BackgroundKind,
  label: string | undefined,
  range: vscode.Range
): vscode.Hover | undefined {
  if (isSvgPath(fsPath)) {
    const raw = loadSvgFile(fsPath);
    if (!raw) {
      return undefined;
    }
    return buildSvgHover(raw, size, background, label, range);
  }

  const dataUri = previewDataUri(fsPath, size, background);
  if (!dataUri) {
    return undefined;
  }

  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportHtml = true;
  md.appendMarkdown(
    `<img src="${dataUri}" width="${size}" height="${size}" alt="preview" style="object-fit:contain;" />`
  );
  if (label) {
    md.appendMarkdown(`\n\n\`${label}\``);
  }
  return new vscode.Hover(md, range);
}

function buildSvgHover(
  svg: string,
  size: number,
  background: BackgroundKind,
  label: string | undefined,
  range: vscode.Range
): vscode.Hover {
  const prepared = wrapForPreview(prepareSvg(svg, size), size, background);
  const previewPath = writePreviewFile(prepared);
  const uri = vscode.Uri.file(previewPath);

  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportHtml = true;
  md.appendMarkdown(`![preview](${uri.toString(true)}|width=${size},height=${size})`);
  md.appendMarkdown(
    `\n\n<img src="${toSvgDataUri(prepared)}" width="${size}" height="${size}" />`
  );
  if (label) {
    md.appendMarkdown(`\n\n\`${label}\``);
  }
  return new vscode.Hover(md, range);
}

function resolveMediaPath(document: vscode.TextDocument, rawPath: string): string | undefined {
  let p = rawPath.trim().replace(/\\/g, "/");
  p = p.split("?")[0].split("#")[0];

  if (/^(https?:|data:|vscode:)/i.test(p)) {
    return undefined;
  }

  if (path.isAbsolute(rawPath) || /^[a-zA-Z]:[\\/]/.test(rawPath)) {
    return path.normalize(rawPath);
  }

  if (p.startsWith("/")) {
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length) {
      const candidate = path.join(folders[0].uri.fsPath, p.slice(1));
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  const fromFile = path.resolve(path.dirname(document.uri.fsPath), p);
  if (fs.existsSync(fromFile)) {
    return fromFile;
  }

  const folders = vscode.workspace.workspaceFolders;
  if (folders?.length) {
    const root = folders[0].uri.fsPath;
    const aliases = [
      p.replace(/^@\//, "src/"),
      p.replace(/^~\//, ""),
      path.join("public", p.replace(/^\//, "")),
      path.join("frontend", "public", p.replace(/^\//, "")),
      path.join("frontend", "src", p.replace(/^@\//, "").replace(/^\//, "")),
    ];

    for (const alias of aliases) {
      const candidate = path.join(root, alias);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return fromFile;
}

function unescapePath(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}
