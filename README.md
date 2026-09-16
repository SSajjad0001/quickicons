# QuickIcons

Quickly preview icons and images from any folder in Explorer — without opening each file.

Supports **SVG**, **PNG**, **JPG**, **JPEG**, **GIF**, **WebP**, **ICO**, **BMP**, and **AVIF**.

## How it works

1. Select a folder that contains icons (for example `assets/icons`) in the Explorer.
2. Start the preview flow in either way:
   - Press **Shift+Q**, then **I**
   - Or right‑click the folder → **QuickIcons: Browse Icons Here**
3. The **Icons** view opens under Explorer with a **search box** at the top.
4. Type at least **2 characters** of a filename (for example `sf` or `sfs.svg`) — the list filters as you type.
5. Check **SVG** at the end of the search row, paste SVG markup, and matching / similar SVG icons are listed with a similarity score.
6. Move across matches to update **Icon Preview**, or click a row to focus that icon.

That is the full loop: pick a folder → open the icon list → skim previews → open only what you need.

## Shortcut

| Action | Shortcut |
|--------|----------|
| Browse icons in the selected Explorer folder | **Shift+Q** then **I** |

Works while the Explorer is focused.

## Commands

- **QuickIcons: Browse Icons Here** — load icons from the selected folder or image’s parent folder
- **QuickIcons: Preview Active Icon** — show the current file in Icon Preview
- **QuickIcons: Refresh Icon List** — reload the Icons view
- **QuickIcons: Toggle Previews** — turn previews on or off

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `quickicons.enabled` | `true` | Enable or disable QuickIcons |
| `quickicons.autoPreviewOnOpen` | `true` | Update Icon Preview when an image/SVG is opened |
| `quickicons.previewSize` | `96` | Preview size in pixels |
| `quickicons.showFileName` | `true` | Show the file name under the preview |
| `quickicons.background` | `checker` | Preview background: `checker`, `light`, `dark`, or `transparent` |
| `quickicons.recursive` | `true` | Include icons from subfolders |
| `quickicons.maxDepth` | `8` | Max subfolder depth when recursive is on |

## Tips

- Use it on icon packs and asset folders to find the right file faster.
- If the Icons view is hidden, open the Explorer view menu and enable **Icons**.
