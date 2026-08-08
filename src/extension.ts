import * as vscode from 'vscode';

const VIEW_TYPE = 'markdownplusplus.editor';
const CONFIG_SECTION = 'markdownplusplus';
type ImagePasteMode = 'assets' | 'base64';
const reservedImageTargets = new Set<string>();
type LocalPreviewMode = 'source' | 'preview';

export function activate(context: vscode.ExtensionContext): void {
  let globalPreviewEnabled = getConfigurationValue<boolean>('globalLivePreview', false);
  const localPreviewModes = new Map<string, LocalPreviewMode>();
  const openingPreviews = new Set<string>();
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW_TYPE, {
    async resolveCustomTextEditor(document, webviewPanel) {
      const webview = webviewPanel.webview;
      const documentDirectory = vscode.Uri.joinPath(document.uri, '..');
      const workspaceRoots = vscode.workspace.workspaceFolders?.map(folder => folder.uri) ?? [];
      webview.options = {
        enableScripts: true,
        localResourceRoots: [context.extensionUri, documentDirectory, ...workspaceRoots]
      };
      webview.html = getHtml(webview, context.extensionUri);

      let applyingChange = false;
      let editQueue = Promise.resolve();
      const sendDocument = () => webview.postMessage({
        type: 'document',
        text: document.getText(),
        documentBase: `${webview.asWebviewUri(documentDirectory).toString(true).replace(/\/$/, '')}/`,
        imagePasteMode: getImagePasteMode(document.uri)
      });

      const changeListener = vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.uri.toString() === document.uri.toString() && !applyingChange) sendDocument();
      });
      const configListener = vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(`${CONFIG_SECTION}.imagePasteMode`, document.uri)) {
          webview.postMessage({ type: 'config', imagePasteMode: getImagePasteMode(document.uri) });
        }
      });
      webviewPanel.onDidDispose(() => { changeListener.dispose(); configListener.dispose(); });

      const handleWebviewMessage = async (message: unknown): Promise<void> => {
        if (!isWebviewMessage(message)) return;
        try {
          switch (message.type) {
            case 'ready':
              sendDocument();
              return;
            case 'update': {
              if (!Array.isArray(message.changes)) return;
              const changes = message.changes.filter((change: unknown): change is { from: number; to: number; insert: string } => {
                if (!change || typeof change !== 'object') return false;
                const candidate = change as { from?: unknown; to?: unknown; insert?: unknown };
                return Number.isInteger(candidate.from) && Number.isInteger(candidate.to)
                  && Number(candidate.from) >= 0 && Number(candidate.to) >= Number(candidate.from) && typeof candidate.insert === 'string';
              });
              if (changes.length !== message.changes.length) {
                webview.postMessage({ type: 'requestSnapshot' });
                return;
              }
              editQueue = editQueue.catch(() => undefined).then(async () => {
                applyingChange = true;
                try {
                  const documentLength = document.getText().length;
                  if (changes.some(change => change.to > documentLength)) throw new Error('Received an out-of-date Markdown edit.');
                  const edit = new vscode.WorkspaceEdit();
                  for (const change of changes) edit.replace(document.uri, new vscode.Range(document.positionAt(change.from), document.positionAt(change.to)), change.insert);
                  const applied = await vscode.workspace.applyEdit(edit);
                  if (!applied) throw new Error('VS Code rejected a Markdown edit.');
                  if (Number.isInteger(message.expectedLength) && document.getText().length !== message.expectedLength) {
                    webview.postMessage({ type: 'requestSnapshot' });
                  }
                } finally { applyingChange = false; }
              }).catch(error => {
                console.error('Markdown++ save error:', error);
                webview.postMessage({ type: 'requestSnapshot' });
              });
              return;
            }
            case 'snapshot': {
              if (typeof message.text !== 'string') return;
              const snapshot = message.text;
              editQueue = editQueue.catch(() => undefined).then(async () => {
                applyingChange = true;
                try {
                  const edit = new vscode.WorkspaceEdit();
                  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), snapshot);
                  const applied = await vscode.workspace.applyEdit(edit);
                  if (!applied) throw new Error('VS Code rejected the Markdown recovery snapshot.');
                } finally { applyingChange = false; }
              }).catch(error => { console.error('Markdown++ recovery error:', error); });
              return;
            }
            case 'openLink': {
              if (typeof message.href !== 'string') return;
              const target = vscode.Uri.parse(message.href);
              if (target.scheme === 'http' || target.scheme === 'https' || target.scheme === 'mailto') await vscode.env.openExternal(target);
              else {
                const localTarget = message.href.startsWith('/')
                  ? vscode.Uri.joinPath(vscode.workspace.getWorkspaceFolder(document.uri)?.uri ?? documentDirectory, message.href.slice(1))
                  : vscode.Uri.joinPath(documentDirectory, message.href);
                await vscode.commands.executeCommand('vscode.open', localTarget);
              }
              return;
            }
            case 'copyText':
              if (typeof message.text === 'string') await vscode.env.clipboard.writeText(message.text);
              return;
            case 'savePastedImage': {
              if (typeof message.requestId !== 'string' || typeof message.dataUrl !== 'string') return;
              try {
                const relativePath = await savePastedImage(document.uri, message.dataUrl, typeof message.originalName === 'string' ? message.originalName : '');
                webview.postMessage({ type: 'pastedImageSaved', requestId: message.requestId, markdown: `![pasted image](${relativePath})` });
              } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error('Markdown++ image save error:', error);
                webview.postMessage({ type: 'pastedImageError', requestId: message.requestId, message: errorMessage });
              }
              return;
            }
            case 'rendererError': {
              if (typeof message.message !== 'string') return;
              const area = typeof message.area === 'string' ? message.area : 'renderer';
              void vscode.window.showErrorMessage(`Markdown++ ${area}: ${message.message.slice(0, 1_000)}`);
            }
          }
        } catch (error) {
          console.error('Markdown++ message handler error:', error);
          if (message.type === 'update' || message.type === 'snapshot') webview.postMessage({ type: 'requestSnapshot' });
        }
      };
      webview.onDidReceiveMessage(message => { void handleWebviewMessage(message); });
    }
  }, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }));

  const toggleLivePreview = async (commandUri?: vscode.Uri) => {
    const { uri, isLivePreview } = getActiveMarkdownResource(commandUri);
    if (!uri) return;
    const key = uri.toString();
    const isLocalButton = Boolean(commandUri);
    if (isLocalButton) {
      const next: LocalPreviewMode = isLivePreview ? 'source' : 'preview';
      localPreviewModes.set(key, next);
      if (next === 'source') await openSource(uri);
      else await openPreview(uri, openingPreviews);
      return;
    }
    globalPreviewEnabled = !globalPreviewEnabled;
    await vscode.workspace.getConfiguration(CONFIG_SECTION).update('globalLivePreview', globalPreviewEnabled, vscode.ConfigurationTarget.Global);
    localPreviewModes.clear();
    if (globalPreviewEnabled) await openPreview(uri, openingPreviews);
    else await openSource(uri);
    void vscode.window.showInformationMessage(`Markdown++ global Live Preview: ${globalPreviewEnabled ? 'on' : 'off'}.`);
  };
  context.subscriptions.push(vscode.commands.registerCommand('markdownplusplus.toggle', toggleLivePreview));
  const toggleLocalLivePreview = async () => {
    const { uri } = getActiveMarkdownResource();
    if (uri) await toggleLivePreview(uri);
  };
  context.subscriptions.push(vscode.commands.registerCommand('markdownplusplus.toggleLocal', toggleLocalLivePreview));
  const toggleImagePasteMode = async () => {
    const { uri } = getActiveMarkdownResource();
    const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION, uri);
    const current = getImagePasteMode(uri);
    const next: ImagePasteMode = current === 'assets' ? 'base64' : 'assets';
    const inspected = configuration.inspect<ImagePasteMode>('imagePasteMode');
    const target = inspected?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await configuration.update('imagePasteMode', next, target);
    void vscode.window.showInformationMessage(`Markdown++ image paste mode: ${next === 'assets' ? 'Assets folder' : 'Base64 embedding'}.`);
  };
  context.subscriptions.push(vscode.commands.registerCommand('markdownplusplus.toggleImagePasteMode', toggleImagePasteMode));

  const openMarkdownInGlobalPreview = (document: vscode.TextDocument) => {
    if (!globalPreviewEnabled || !document.uri.path.toLowerCase().endsWith('.md')) return;
    const key = document.uri.toString();
    if (localPreviewModes.get(key) === 'source') return;
    void openPreview(document.uri, openingPreviews);
  };
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(openMarkdownInGlobalPreview));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration(`${CONFIG_SECTION}.globalLivePreview`)) return;
    globalPreviewEnabled = getConfigurationValue<boolean>('globalLivePreview', false);
  }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor?.document.uri.path.toLowerCase().endsWith('.md')) {
      enableWordWrapSafely(editor.document.uri);
      openMarkdownInGlobalPreview(editor.document);
    }
  }));
  if (vscode.window.activeTextEditor) {
    enableWordWrapSafely(vscode.window.activeTextEditor.document.uri);
    openMarkdownInGlobalPreview(vscode.window.activeTextEditor.document);
  }
}

function isWebviewMessage(value: unknown): value is Record<string, unknown> & { type: string } {
  return Boolean(value) && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string';
}

function getImagePasteMode(uri?: vscode.Uri): ImagePasteMode {
  return getConfigurationValue<ImagePasteMode>('imagePasteMode', 'assets', uri) === 'base64' ? 'base64' : 'assets';
}

function getConfigurationValue<T>(key: string, fallback: T, uri?: vscode.Uri): T {
  const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION, uri);
  const inspected = configuration.inspect<T>(key);
  const hasCurrentValue = inspected?.globalValue !== undefined
    || inspected?.workspaceValue !== undefined
    || inspected?.workspaceFolderValue !== undefined;
  return hasCurrentValue
    ? configuration.get<T>(key, fallback)
    : fallback;
}

async function savePastedImage(documentUri: vscode.Uri, dataUrl: string, originalName: string): Promise<string> {
  const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i);
  if (!match) throw new Error('The clipboard did not provide a supported image.');
  const bytes = Buffer.from(match[2].replace(/[\r\n]/g, ''), 'base64');
  if (!bytes.length) throw new Error('The pasted image is empty.');

  const assetsDirectory = vscode.Uri.joinPath(documentUri, '..', 'assets');
  await vscode.workspace.fs.createDirectory(assetsDirectory);
  const extension = imageFileExtension(match[1], originalName);
  const baseName = `image-${formatImageTimestamp(new Date())}`;
  let suffix = 1;
  while (true) {
    const fileName = `${baseName}${suffix === 1 ? '' : `-${suffix}`}.${extension}`;
    const target = vscode.Uri.joinPath(assetsDirectory, fileName);
    const targetKey = target.toString();
    if (reservedImageTargets.has(targetKey)) { suffix++; continue; }
    try {
      await vscode.workspace.fs.stat(target);
      suffix++;
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') throw error;
      if (reservedImageTargets.has(targetKey)) { suffix++; continue; }
      reservedImageTargets.add(targetKey);
      try {
        await vscode.workspace.fs.writeFile(target, bytes);
        return `assets/${fileName}`;
      } finally { reservedImageTargets.delete(targetKey); }
    }
  }
}

function imageFileExtension(mimeType: string, originalName: string): string {
  const extensions: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/tiff': 'tiff', 'image/avif': 'avif'
  };
  const known = extensions[mimeType.toLowerCase()];
  if (known) return known;
  const fromName = originalName.match(/\.([a-z0-9]{1,8})$/i)?.[1].toLowerCase();
  if (fromName) return fromName;
  throw new Error(`Unsupported pasted image type: ${mimeType}`);
}

function formatImageTimestamp(date: Date): string {
  const part = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
}

async function openSource(uri: vscode.Uri): Promise<void> {
  await enableWordWrap(uri);
  await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
}

async function openPreview(uri: vscode.Uri, openingPreviews: Set<string>): Promise<void> {
  const key = uri.toString();
  if (openingPreviews.has(key)) return;
  openingPreviews.add(key);
  try { await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE); }
  finally { openingPreviews.delete(key); }
}

function getActiveMarkdownResource(commandUri?: vscode.Uri): { uri?: vscode.Uri; isLivePreview: boolean } {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri; viewType?: string } | undefined;
  const uri = commandUri ?? vscode.window.activeTextEditor?.document.uri ?? input?.uri;
  return { uri: uri?.path.toLowerCase().endsWith('.md') ? uri : undefined, isLivePreview: input?.viewType === VIEW_TYPE };
}

async function enableWordWrap(uri: vscode.Uri): Promise<void> {
  if (!getConfigurationValue<boolean>('enableMarkdownWordWrap', true, uri)) return;
  const editorConfig = vscode.workspace.getConfiguration('editor', uri);
  if (editorConfig.get<string>('wordWrap') !== 'on') {
    await editorConfig.update('wordWrap', 'on', vscode.ConfigurationTarget.Workspace);
  }
}

function enableWordWrapSafely(uri: vscode.Uri): void {
  void enableWordWrap(uri).catch(error => console.error('Markdown++ word wrap configuration error:', error));
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Markdown++</title><style>${styles()}${themeStyles()}</style></head><body>
  <main id="editor" aria-label="Markdown live preview"></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
}

function styles(): string { return `
  :root{color-scheme:dark;--bg:#1e1e1e;--surface:#171717;--line:#3c3c3c;--text:#d4d4d4;--accent:#7aa2f7}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 "Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}main{max-width:920px;margin:auto;padding:34px 48px 120px}.cm-editor{outline:none}.cm-scroller{font:inherit;line-height:1.6;overflow-x:hidden!important}.cm-content{caret-color:#fff!important;padding-bottom:120px}.cm-line{padding:0 2px;min-height:1.6em}.cm-line.cm-setext-marker-line{height:0!important;min-height:0!important;line-height:0!important;padding:0!important;overflow:hidden}.cm-selectionBackground,.cm-content ::selection{background:#264f78!important}.cm-editor.cm-focused .cm-cursor,.cm-dropCursor{border-left:2px solid #fff!important}.cm-fat-cursor{background:#fff!important;color:#111!important}.cm-md-heading-1{font-size:2em;line-height:1.25;font-weight:700}.cm-md-heading-2{font-size:1.5em;line-height:1.25;font-weight:700}.cm-md-heading-3{font-size:1.25em;line-height:1.3;font-weight:700}.cm-md-heading-4{font-size:1.1em;line-height:1.35;font-weight:700}.cm-md-heading-5{font-size:1em;line-height:1.4;font-weight:700}.cm-md-heading-6{font-size:.9em;line-height:1.45;font-weight:700;color:var(--vscode-descriptionForeground,var(--text))}.cm-md-heading-1,.cm-md-heading-2,.cm-md-heading-3,.cm-md-heading-4,.cm-md-heading-5,.cm-md-heading-6{margin-left:0}.cm-md-heading-line-1{padding-top:.6em!important;padding-bottom:.45em!important}.cm-md-heading-line-2{padding-top:.5em!important;padding-bottom:.38em!important}.cm-md-heading-line-3{padding-top:.4em!important;padding-bottom:.3em!important}.cm-md-heading-line-4{padding-top:.32em!important;padding-bottom:.24em!important}.cm-md-heading-line-5{padding-top:.25em!important;padding-bottom:.2em!important}.cm-md-heading-line-6{padding-top:.2em!important;padding-bottom:.16em!important}.cm-md-strong{font-weight:700;color:var(--accent)}.cm-md-emphasis{font-style:italic}.cm-md-strikethrough{text-decoration:line-through}.cm-md-inline-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#2a2a2a;color:#e7c680;border-radius:4px;padding:.08em .3em;line-height:1.35;box-decoration-break:clone;-webkit-box-decoration-break:clone}.cm-link-widget{color:var(--accent);text-decoration:underline;text-underline-offset:2px;cursor:pointer}.cm-horizontal-rule{display:inline-block;width:100%;height:1.6em;border-top:1px solid var(--line);transform:translateY(.8em);vertical-align:top}.cm-md-codeblock{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.cm-line.cm-md-code-line{background:var(--surface);padding-left:14px;padding-right:14px}.cm-line.cm-md-code-first{position:relative;border-radius:6px 6px 0 0;padding-top:8px}.cm-line.cm-md-code-last{border-radius:0 0 6px 6px;padding-bottom:12px}.copy-code{position:absolute;right:8px;top:6px;z-index:2;background:#292929dd;border:1px solid #555;color:var(--text);border-radius:4px;padding:2px 7px;cursor:pointer;opacity:.25}.cm-md-code-first:hover .copy-code,.copy-code:focus{opacity:1}.cm-list-marker{display:inline;color:var(--text)}.cm-task-checkbox{appearance:none;width:16px;height:16px;margin:0 8px 0 0;border:1.5px solid #777;border-radius:4px;background:transparent;vertical-align:middle;transform:translateY(-1px);cursor:pointer}.cm-task-checkbox:checked{background:var(--accent);border-color:var(--accent)}.cm-task-checkbox:checked:after{content:'✓';display:block;color:#111;font:bold 13px/14px sans-serif;text-align:center}.cm-line.cm-quote-line{border-left:3px solid #5c6370;padding-left:14px;color:#b8bcc5}.cm-line.cm-quote-first{padding-top:4px}.cm-line.cm-quote-last{padding-bottom:4px}.cm-table-widget{display:block;width:100%;max-width:100%;overflow-x:auto;overflow-y:hidden;margin:.65em 0;padding-bottom:3px}.cm-table-widget table{width:max-content;min-width:100%;border-collapse:collapse;table-layout:auto}.cm-table-widget th,.cm-table-widget td{min-width:11rem;padding:6px 10px;border:1px solid var(--line);text-align:left;white-space:nowrap}.cm-table-widget th{font-weight:700;background:#272727}.cm-table-strong{font-weight:700;color:var(--accent)}.cm-table-widget::-webkit-scrollbar{height:9px}.cm-table-widget::-webkit-scrollbar-thumb{background:#555;border-radius:5px}.cm-table-widget::-webkit-scrollbar-track{background:#252525}.cm-image-widget{position:relative;display:inline-block;max-width:100%;line-height:0;vertical-align:middle}.cm-image-widget img{max-width:100%;vertical-align:middle}.cm-html-widget{color:inherit}.cm-html-block{display:block;margin:.5em 0}.cm-html-widget kbd{background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:.08em .38em;box-shadow:0 1px 0 var(--line)}.cm-html-widget details{padding:.5em .75em;border:1px solid var(--line);border-radius:6px}.cm-tooltip-autocomplete{background:#252525!important;border:1px solid #474747!important;border-radius:7px!important;box-shadow:0 8px 24px #0008!important;overflow:hidden}.cm-tooltip-autocomplete>ul{font-family:inherit!important;max-height:280px!important}.cm-tooltip-autocomplete>ul>li{padding:6px 10px!important;color:var(--text)!important}.cm-tooltip-autocomplete>ul>li[aria-selected]{background:#3b4261!important;color:#fff!important}.cm-completionLabel{font-weight:600}.cm-completionDetail{color:#aaa;font-style:normal!important;margin-left:12px!important}`; }

function themeStyles(): string { return `
  :root{color-scheme:light dark;--bg:var(--vscode-editor-background,#1e1e1e);--surface:var(--vscode-textCodeBlock-background,var(--vscode-editorWidget-background,#171717));--line:var(--vscode-panel-border,var(--vscode-editorWidget-border,#3c3c3c));--text:var(--vscode-editor-foreground,#d4d4d4);--accent:var(--vscode-textLink-foreground,#3794ff);--horizontal-rule-color:color-mix(in srgb,var(--vscode-editor-foreground,#d4d4d4) 32%,var(--vscode-editor-background,#1e1e1e));--code-block-border:var(--vscode-contrastBorder,color-mix(in srgb,var(--vscode-editor-foreground,#d4d4d4) 24%,var(--vscode-editor-background,#1e1e1e)))}
  body{background:var(--bg);color:var(--text);font-family:var(--vscode-editor-font-family,"Inter",sans-serif);font-size:var(--vscode-editor-font-size,14px);font-weight:var(--vscode-editor-font-weight,normal)}
  body,.cm-editor,.cm-scroller,.cm-content,.cm-line,.cm-md-inline-code,.cm-md-codeblock{font-family:var(--vscode-editor-font-family,monospace)!important}
  .cm-content{caret-color:var(--vscode-editorCursor-foreground,#fff)!important}.cm-editor.cm-focused .cm-cursor,.cm-dropCursor{border-left-color:var(--vscode-editorCursor-foreground,#fff)!important}.cm-fat-cursor{background:var(--vscode-editorCursor-foreground,#fff)!important;color:var(--bg)!important}
  .cm-selectionBackground,.cm-content ::selection{background:var(--vscode-editor-selectionBackground,#264f78)!important}
  .cm-horizontal-rule{border-top-color:var(--horizontal-rule-color)!important}
  main{width:calc(100% - 24px);max-width:1280px;padding:24px 12px 100px}
  .cm-editor,.cm-editor.cm-focused{outline:none!important;border:0!important;box-shadow:none!important}
  .cm-md-inline-code{background:var(--vscode-textCodeBlock-background,var(--surface));color:var(--text);padding-top:.04em;padding-bottom:.04em;line-height:1.25}
  .cm-line.cm-md-code-line{background:var(--surface)!important;background-clip:padding-box!important;box-shadow:inset 1px 0 var(--code-block-border),inset -1px 0 var(--code-block-border)}
  .cm-line.cm-md-code-first{padding-top:8px;border-top:6px solid transparent;border-radius:10px 10px 0 0 / 16px 16px 0 0!important;overflow:visible!important}
  .cm-line.cm-md-code-last{padding-bottom:8px;border-bottom:6px solid transparent;border-radius:0 0 10px 10px / 0 0 16px 16px!important;overflow:visible!important}
  .cm-line.cm-md-code-first:not(.cm-md-code-last){box-shadow:inset 1px 0 var(--code-block-border),inset -1px 0 var(--code-block-border),inset 0 1px var(--code-block-border)}
  .cm-line.cm-md-code-last:not(.cm-md-code-first){box-shadow:inset 1px 0 var(--code-block-border),inset -1px 0 var(--code-block-border),inset 0 -1px var(--code-block-border)}
  .cm-line.cm-md-code-first.cm-md-code-last{border-radius:10px / 16px!important;box-shadow:inset 1px 0 var(--code-block-border),inset -1px 0 var(--code-block-border),inset 0 1px var(--code-block-border),inset 0 -1px var(--code-block-border)}
  .copy-code{top:10px;right:10px;width:30px;height:28px;padding:0;min-height:0;display:grid;place-items:center;line-height:0;border-width:1px;border-style:solid;border-radius:6px}
  .copy-code svg{display:block;width:15px;height:15px;fill:var(--vscode-editorWidget-background,var(--surface));stroke:currentColor;stroke-width:1.5;vector-effect:non-scaling-stroke}
  .copy-code{background:var(--vscode-editorWidget-background,var(--surface));border-color:var(--code-block-border);color:var(--text)}
  .copy-code.is-copied{opacity:1!important;color:var(--vscode-editor-foreground,var(--text));border-color:color-mix(in srgb,currentColor 55%,transparent);background:color-mix(in srgb,currentColor 12%,var(--vscode-editorWidget-background,var(--surface)))}
  .cm-line.cm-link-reference-line{height:0!important;min-height:0!important;line-height:0!important;padding:0!important;overflow:hidden!important;visibility:hidden}
  .cm-task-checkbox{border-color:color-mix(in srgb,var(--vscode-editor-foreground,#d4d4d4) 58%,transparent);background:var(--vscode-checkbox-background,transparent);box-shadow:inset 0 0 0 .25px color-mix(in srgb,var(--vscode-editor-foreground,#d4d4d4) 30%,transparent)}.cm-task-checkbox:checked{background:var(--vscode-checkbox-selectBackground,var(--vscode-button-background,var(--accent)));border-color:var(--vscode-checkbox-selectBorder,var(--accent))}.cm-task-checkbox:checked:after{color:var(--vscode-checkbox-foreground,var(--vscode-button-foreground,#fff))}
  :root{--quote-border-color:var(--vscode-panel-border,var(--vscode-editorWidget-border,var(--vscode-descriptionForeground,var(--line))))}
  .cm-line.cm-quote-line{border-left:0!important;color:var(--vscode-descriptionForeground,var(--text));background-repeat:no-repeat;background-size:3px 100%;background-image:linear-gradient(var(--quote-border-color),var(--quote-border-color));background-position:0 0;padding-left:14px}
  .cm-line.cm-quote-depth-2{background-image:linear-gradient(var(--quote-border-color),var(--quote-border-color)),linear-gradient(var(--quote-border-color),var(--quote-border-color));background-size:3px 100%,3px 100%;background-position:0 0,10px 0;padding-left:24px}
  .cm-line.cm-quote-depth-3{background-image:linear-gradient(var(--quote-border-color),var(--quote-border-color)),linear-gradient(var(--quote-border-color),var(--quote-border-color)),linear-gradient(var(--quote-border-color),var(--quote-border-color));background-size:3px 100%,3px 100%,3px 100%;background-position:0 0,10px 0,20px 0;padding-left:34px}
  .cm-line.cm-quote-depth-4{background-image:linear-gradient(var(--quote-border-color),var(--quote-border-color)),linear-gradient(var(--quote-border-color),var(--quote-border-color)),linear-gradient(var(--quote-border-color),var(--quote-border-color)),linear-gradient(var(--quote-border-color),var(--quote-border-color));background-size:3px 100%,3px 100%,3px 100%,3px 100%;background-position:0 0,10px 0,20px 0,30px 0;padding-left:44px}
  .cm-table-widget th{background:var(--vscode-editorWidget-background,var(--surface))}.cm-table-widget th,.cm-table-widget td{border-color:var(--line)}
  .cm-table-widget::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background,#555)}.cm-table-widget::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground,#777)}.cm-table-widget::-webkit-scrollbar-track{background:var(--vscode-editor-background,var(--bg))}
  .cm-content{min-width:0!important;max-width:100%!important}.cm-table-widget{display:block!important;width:100%!important;min-width:0!important;max-width:100%!important;overflow-x:auto!important;overflow-y:hidden!important;contain:inline-size}.cm-table-widget table{width:max-content!important;min-width:calc(100% - 1px)!important;max-width:none!important;margin-right:1px}
  .cm-line{padding-left:0!important;padding-right:0!important}.cm-line.cm-md-code-line{padding-left:14px!important;padding-right:14px!important}.cm-line.cm-quote-line{padding-left:14px!important}.cm-line.cm-quote-depth-2{padding-left:24px!important}.cm-line.cm-quote-depth-3{padding-left:34px!important}.cm-line.cm-quote-depth-4{padding-left:44px!important}
  .cm-task-completed-text{color:var(--vscode-disabledForeground,var(--vscode-descriptionForeground,#888))!important;text-decoration:line-through;text-decoration-thickness:1px}
  .cm-tooltip-autocomplete{background:var(--vscode-editorSuggestWidget-background,var(--vscode-editorWidget-background,#252525))!important;border-color:var(--vscode-editorSuggestWidget-border,var(--line))!important;color:var(--vscode-editorSuggestWidget-foreground,var(--text))!important}.cm-tooltip-autocomplete>ul>li[aria-selected]{background:var(--vscode-editorSuggestWidget-selectedBackground,#3b4261)!important;color:var(--vscode-editorSuggestWidget-selectedForeground,#fff)!important}.cm-completionDetail{color:var(--vscode-descriptionForeground,#aaa)!important}
`; }
