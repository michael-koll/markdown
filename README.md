# Markdown++

**An Obsidian-like live WYSIWYG Markdown editor for Visual Studio Code.**

Markdown++ turns standard Markdown files into a continuous Live Preview editor. The document stays readable while you type: Markdown syntax is hidden in rendered content and revealed only for the element you are editing or the lines you select.

Your files remain ordinary Markdown. Switch between Live Preview and the source editor at any time with the preview button in the editor title.

## Features

- Continuous Live Preview editing without separate text input blocks or a formatting toolbar
- Granular source reveal for the active heading, emphasis span, link, list item, quote, table, code block, or selection
- Headings, bold, italic, strikethrough, links, reference links, lists, task lists, quotes, horizontal rules, tables, code, images, and sanitized inline HTML
- Nested and mixed ordered/unordered lists, nested quotes, and interactive task checkboxes
- Per-table horizontal scrolling when a table is wider than the editor
- Theme-aware colors, borders, cursor, typography, and the configured VS Code editor font
- A copy button on rendered code blocks
- Native editor navigation, selections, undo/redo, list continuation, and Markdown word wrapping
- Local image pasting to an `assets` folder by default, with optional Base64 embedding
- Slash commands for common Markdown structures

## Getting Started

1. Open a `.md` file.
2. Click the preview icon in the editor title, or run **Markdown++: Toggle Live Preview** from the Command Palette.
3. Click any rendered element to edit its Markdown source in place.
4. Use the same editor-title button to return to the regular source editor.

Markdown++ does not replace or convert the file format. Changes made in either view are saved to the same Markdown document.

## Slash Commands

Type `/` on a line to open the suggestion menu, then choose a command with the keyboard or mouse.

| Command | Inserts |
| --- | --- |
| `/todo` | Task-list item: `- [ ]` |
| `/bullet` | Unordered-list item: `-` |
| `/numbered` | Ordered-list item starting with `1.` |
| `/quote` | Block quote: `>` |
| `/line` | Horizontal rule: `---` |
| `/code` | Fenced code block |
| `/table` | Table with two columns and two visible rows |

For a custom table, type its dimensions directly and press Enter. For example, `/4x3` creates four columns and three visible rows, including the header row. Custom dimension commands are intentionally not listed in the suggestion menu. Dimensions are limited to 12 columns and 12 rows.

## Image Pasting

### Assets folder (default)

When you paste an image, Markdown++ creates an `assets` folder beside the current Markdown file, saves the image there, and inserts a native relative Markdown link:

```markdown
![pasted image](assets/image-20260807-145500.png)
```

File names are collision-safe, and large clipboard images are supported.

### Base64 embedding

Base64 mode stores the complete image directly in the Markdown document as a `data:image/...;base64,...` URL. This makes the document self-contained, but can make its source substantially larger.

Run **Markdown++: Toggle Image Paste Mode** from the Command Palette to switch modes. The selected mode is saved in the applicable VS Code configuration scope.

## Editing and Navigation

- `Enter` continues ordered lists, unordered lists, task lists, and quotes with exactly one new line.
- `Tab` and `Shift+Tab` indent and outdent list items.
- Arrow keys move through document lines and enter or leave editable block content as needed.
- `Ctrl+Z` / `Ctrl+Y` on Windows and Linux, or the corresponding macOS shortcuts, undo and redo individual changes.
- Completed task-list items are dimmed and struck through in Live Preview.
- `Ctrl+Click` / `Cmd+Click` opens rendered links.

## Supported Markdown

Markdown++ focuses on standard CommonMark and common GitHub Flavored Markdown features:

- ATX headings (`#` through `######`) and Setext headings
- Bold, italic, bold italic, strikethrough, escapes, and hard line breaks
- Inline links, optional link titles, autolinks, and reference-style links
- Ordered, unordered, nested, mixed, and task lists
- Block quotes and nested block quotes
- Horizontal rules
- Tables
- Inline code, fenced code blocks, tilde-fenced code blocks, and indented code blocks
- Relative local images and Base64 data images
- Sanitized embedded HTML

The Live Preview is designed around native Markdown. Image resizing metadata and other editor-specific Markdown extensions are intentionally not added.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `markdownplusplus.imagePasteMode` | `assets` | Saves pasted images in a neighboring `assets` folder or embeds them as `base64`. |
| `markdownplusplus.enableMarkdownWordWrap` | `true` | Enables word wrapping when Markdown files are opened in the regular source editor. |

The image mode can also be changed with **Markdown++: Toggle Image Paste Mode**.

## Privacy

Markdown++ does not send document content or telemetry to an external service. Assets-mode images remain in your local workspace; Base64-mode images remain inside the Markdown file.

## License

Markdown++ is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). Noncommercial use, inspection, modification, and sharing are permitted. Commercial use is not permitted.

## Release Notes

See [CHANGELOG.md](CHANGELOG.md) for version history.
