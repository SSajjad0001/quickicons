import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export type BackgroundKind = "checker" | "light" | "dark" | "transparent";

/** Supported icon / image extensions */
export const IMAGE_EXTS = [
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".avif",
] as const;

export type ImageExt = (typeof IMAGE_EXTS)[number];

const EXT_SET = new Set<string>(IMAGE_EXTS);
const previewCache = new Map<string, string>();

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function readConfig(): {
  enabled: boolean;
  previewSize: number;
  showFileName: boolean;
  background: BackgroundKind;
  autoPreview: boolean;
  recursive: boolean;
  maxDepth: number;
} {
  const config = vscode.workspace.getConfiguration("quickicons");
  return {
    enabled: config.get<boolean>("enabled", true),
    previewSize: clamp(config.get<number>("previewSize", 96), 16, 512),
    showFileName: config.get<boolean>("showFileName", true),
    background: config.get<string>("background", "checker") as BackgroundKind,
    autoPreview: config.get<boolean>("autoPreviewOnOpen", true),
    recursive: config.get<boolean>("recursive", true),
    maxDepth: clamp(config.get<number>("maxDepth", 8), 1, 20),
  };
}

export function getExt(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

export function isImagePath(filePath: string): boolean {
  return EXT_SET.has(getExt(filePath));
}

export function isImageUri(uri: vscode.Uri | undefined): boolean {
  return !!uri && isImagePath(uri.fsPath);
}

export function isSvgPath(filePath: string): boolean {
  return getExt(filePath) === ".svg";
}

export function isSvgUri(uri: vscode.Uri | undefined): boolean {
  return !!uri && isSvgPath(uri.fsPath);
}

export function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".bmp":
      return "image/bmp";
    case ".avif":
      return "image/avif";
    default:
      return "application/octet-stream";
  }
}

/** Regex fragment for image extensions */
export const IMAGE_EXT_PATTERN = IMAGE_EXTS.map((e) => e.slice(1)).join("|");

export function prepareSvg(raw: string, size: number): string {
  let svg = raw.trim();
  svg = svg.replace(/<\?xml[\s\S]*?\?>/i, "").replace(/<!DOCTYPE[\s\S]*?>/i, "").trim();

  if (!/^<svg[\s>]/i.test(svg)) {
    return svg;
  }

  if (!/\sxmlns\s*=/.test(svg)) {
    svg = svg.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  if (!/\sviewBox\s*=/i.test(svg)) {
    const w = attr(svg, "width");
    const h = attr(svg, "height");
    if (w && h) {
      svg = svg.replace(
        /^<svg\b/i,
        `<svg viewBox="0 0 ${parseLength(w)} ${parseLength(h)}"`
      );
    }
  }

  if (size > 0) {
    svg = svg
      .replace(/\swidth\s*=\s*["'][^"']*["']/i, "")
      .replace(/\sheight\s*=\s*["'][^"']*["']/i, "");
    svg = svg.replace(/^<svg\b/i, `<svg width="${size}" height="${size}"`);
  }

  return svg;
}

export function wrapForPreview(innerSvg: string, size: number, background: BackgroundKind): string {
  const bg = backgroundSvg(background, size);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    bg +
    `<g>${prepareSvg(innerSvg, 0)}</g>` +
    `</svg>`
  );
}

export function writePreviewFile(svg: string): string {
  const hash = crypto.createHash("sha1").update(svg).digest("hex").slice(0, 16);
  const cached = previewCache.get(hash);
  if (cached && fs.existsSync(cached)) {
    return cached;
  }

  const dir = path.join(os.tmpdir(), "quickicons-previews");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${hash}.svg`);
  fs.writeFileSync(filePath, svg, "utf8");
  previewCache.set(hash, filePath);
  return filePath;
}

export function toSvgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

export function loadSvgFile(fsPath: string): string | undefined {
  try {
    return fs.readFileSync(fsPath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Build a data URI suitable for <img src> hover / webview preview.
 * SVGs get size/background wrapping; raster images are base64 of the file bytes.
 */
export function previewDataUri(
  fsPath: string,
  size: number,
  background: BackgroundKind
): string | undefined {
  const ext = getExt(fsPath);
  if (!EXT_SET.has(ext)) {
    return undefined;
  }

  try {
    if (ext === ".svg") {
      const raw = fs.readFileSync(fsPath, "utf8");
      const prepared = wrapForPreview(prepareSvg(raw, size), size, background);
      return toSvgDataUri(prepared);
    }

    const buf = fs.readFileSync(fsPath);
    // Skip huge files in hover tooltips
    if (buf.byteLength > 8 * 1024 * 1024) {
      return undefined;
    }
    return `data:${mimeForExt(ext)};base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}

export type ImageEntry = {
  uri: vscode.Uri;
  /** File name including extension */
  name: string;
  /** Path relative to the browsed folder (posix-style) */
  relativePath: string;
  ext: string;
};

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  "coverage",
]);

/**
 * List every image/icon file in a folder.
 * Includes all formats (svg, png, jpeg, …) — same basename with different
 * extensions are all returned as separate entries.
 */
export function listImagesInFolder(
  dir: string,
  options?: { recursive?: boolean; maxDepth?: number }
): ImageEntry[] {
  const cfg = readConfig();
  const recursive = options?.recursive ?? cfg.recursive;
  const maxDepth = options?.maxDepth ?? cfg.maxDepth;
  const results: ImageEntry[] = [];

  const walk = (current: string, depth: number, relBase: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (
          recursive &&
          depth < maxDepth &&
          !SKIP_DIRS.has(entry.name) &&
          !entry.name.startsWith(".")
        ) {
          walk(full, depth + 1, relBase ? `${relBase}/${entry.name}` : entry.name);
        }
        continue;
      }

      let isFile = entry.isFile();
      if (!isFile && entry.isSymbolicLink()) {
        try {
          isFile = fs.statSync(full).isFile();
        } catch {
          isFile = false;
        }
      }
      if (!isFile) {
        continue;
      }

      // Match by extension (case-insensitive) — keep every format
      if (!isImagePath(entry.name)) {
        continue;
      }

      const ext = getExt(entry.name);
      const relativePath = relBase ? `${relBase}/${entry.name}` : entry.name;
      results.push({
        uri: vscode.Uri.file(full),
        name: entry.name,
        relativePath: relativePath.replace(/\\/g, "/"),
        ext,
      });
    }
  };

  walk(dir, 0, "");

  // Group same icon name across formats: foo.png next to foo.svg
  results.sort((a, b) => {
    const aBase = path.basename(a.name, a.ext).toLowerCase();
    const bBase = path.basename(b.name, b.ext).toLowerCase();
    if (aBase !== bBase) {
      return aBase.localeCompare(bBase);
    }
    if (a.ext !== b.ext) {
      return a.ext.localeCompare(b.ext);
    }
    return a.relativePath.localeCompare(b.relativePath);
  });

  return results;
}

function backgroundSvg(kind: BackgroundKind, size: number): string {
  switch (kind) {
    case "light":
      return `<rect width="${size}" height="${size}" fill="#ffffff"/>`;
    case "dark":
      return `<rect width="${size}" height="${size}" fill="#1e1e1e"/>`;
    case "transparent":
      return "";
    case "checker":
    default: {
      const cell = Math.max(4, Math.floor(size / 8));
      return (
        `<defs>` +
        `<pattern id="qi-checker" width="${cell * 2}" height="${cell * 2}" patternUnits="userSpaceOnUse">` +
        `<rect width="${cell}" height="${cell}" fill="#f0f0f0"/>` +
        `<rect x="${cell}" y="${cell}" width="${cell}" height="${cell}" fill="#f0f0f0"/>` +
        `<rect x="${cell}" width="${cell}" height="${cell}" fill="#cccccc"/>` +
        `<rect y="${cell}" width="${cell}" height="${cell}" fill="#cccccc"/>` +
        `</pattern>` +
        `</defs>` +
        `<rect width="${size}" height="${size}" fill="url(#qi-checker)"/>`
      );
    }
  }
}

function attr(svg: string, name: string): string | undefined {
  const m = svg.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return m?.[1];
}

function parseLength(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : 24;
}
