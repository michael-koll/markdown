import { EditorState, StateField, Transaction } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType, keymap } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { GFM } from '@lezer/markdown';
import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, Completion, CompletionContext, completionKeymap, completionStatus } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, insertNewlineAndIndent, redo, undo } from '@codemirror/commands';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
const host = document.querySelector<HTMLElement>('#editor')!;
let initialised = false;
let applyingHostDocument = false;
let imagePasteMode: 'assets' | 'base64' = 'assets';
let documentBase = '';
let imagePasteSequence = 0;
const pendingImagePastes = new Map<string, { from: number; to: number }>();

class TextWidget extends WidgetType {
  constructor(private readonly text: string, private readonly className: string) { super(); }
  eq(other: TextWidget): boolean { return this.text === other.text && this.className === other.className; }
  toDOM(): HTMLElement { const span = document.createElement('span'); span.className = this.className; span.textContent = this.text; return span; }
}

class TaskWidget extends WidgetType {
  constructor(private readonly checked: boolean, private readonly from: number, private readonly to: number) { super(); }
  eq(other: TaskWidget): boolean { return this.checked === other.checked && this.from === other.from && this.to === other.to; }
  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox'; input.className = 'cm-task-checkbox'; input.checked = this.checked; input.title = this.checked ? 'Mark task as incomplete' : 'Mark task as complete';
    input.addEventListener('mousedown', event => event.stopPropagation());
    input.addEventListener('change', event => {
      event.stopPropagation();
      view.dispatch({ changes: { from: this.from, to: this.to, insert: input.checked ? '[x]' : '[ ]' } });
    });
    return input;
  }
  ignoreEvent(): boolean { return true; }
}

class ImageWidget extends WidgetType {
  constructor(private readonly source: string, private readonly alt: string, private readonly title: string, private readonly from: number) { super(); }
  eq(other: ImageWidget): boolean { return this.source === other.source && this.alt === other.alt && this.title === other.title && this.from === other.from; }
  toDOM(): HTMLElement {
    const wrapper = document.createElement('span'); wrapper.className = 'cm-image-widget'; wrapper.dataset.from = String(this.from);
    const image = document.createElement('img'); image.src = resolveResource(this.source); image.alt = this.alt; if (this.title) image.title = this.title; wrapper.appendChild(image);
    return wrapper;
  }
  ignoreEvent(): boolean { return false; }
}

class LinkWidget extends WidgetType {
  constructor(private readonly label: string, private readonly href: string, private readonly title: string, private readonly from: number) { super(); }
  eq(other: LinkWidget): boolean { return this.label === other.label && this.href === other.href && this.title === other.title && this.from === other.from; }
  toDOM(): HTMLElement {
    const link = document.createElement('span'); link.className = 'cm-link-widget'; link.textContent = this.label; link.title = `${this.title ? `${this.title}\n` : ''}${this.href}\nCtrl+Click to open`;
    link.dataset.from = String(this.from); link.dataset.href = this.href; return link;
  }
  ignoreEvent(): boolean { return false; }
}

class HtmlWidget extends WidgetType {
  constructor(private readonly source: string, private readonly from: number, private readonly block: boolean) { super(); }
  eq(other: HtmlWidget): boolean { return this.source === other.source && this.block === other.block && this.from === other.from; }
  toDOM(): HTMLElement {
    const wrapper = document.createElement(this.block ? 'div' : 'span');
    wrapper.className = this.block ? 'cm-html-widget cm-html-block' : 'cm-html-widget'; wrapper.dataset.from = String(this.from);
    const template = document.createElement('template'); template.innerHTML = this.source;
    sanitiseHtml(template.content);
    template.content.querySelectorAll<HTMLImageElement>('img[src]').forEach(image => { image.src = resolveResource(image.getAttribute('src') ?? ''); });
    wrapper.appendChild(template.content); return wrapper;
  }
  ignoreEvent(): boolean { return false; }
}

function sanitiseHtml(root: DocumentFragment): void {
  root.querySelectorAll('script,style,iframe,object,embed,link,meta,base').forEach(element => element.remove());
  root.querySelectorAll('*').forEach(element => {
    for (const attribute of Array.from(element.attributes)) {
      const value = attribute.value.trim().toLowerCase();
      if (attribute.name.toLowerCase().startsWith('on') || attribute.name.toLowerCase() === 'srcdoc' || ((attribute.name === 'href' || attribute.name === 'src') && value.startsWith('javascript:'))) element.removeAttribute(attribute.name);
    }
  });
}

function resolveResource(source: string): string {
  if (/^(?:data:|blob:|https?:)/i.test(source) || !documentBase) return source;
  try { return new URL(source, documentBase).toString(); } catch { return source; }
}

class HorizontalRuleWidget extends WidgetType {
  constructor(private readonly from: number) { super(); }
  eq(other: HorizontalRuleWidget): boolean { return this.from === other.from; }
  toDOM(): HTMLElement { const rule = document.createElement('span'); rule.className = 'cm-horizontal-rule'; rule.dataset.from = String(this.from); return rule; }
  ignoreEvent(): boolean { return false; }
}

class TableWidget extends WidgetType {
  constructor(private readonly source: string, private readonly from: number) { super(); }
  eq(other: TableWidget): boolean { return this.source === other.source && this.from === other.from; }
  toDOM(editorView: EditorView): HTMLElement {
    const wrapper = document.createElement('span'); wrapper.className = 'cm-table-widget'; wrapper.dataset.from = String(this.from);
    const lines = this.source.split('\n');
    let lineOffset = 0;
    const rows = lines.map((line, index) => {
      const cells = splitTableRow(line, this.from + lineOffset);
      lineOffset += line.length + 1;
      return { index, cells };
    }).filter(row => row.index !== 1 && lines[row.index].trim());
    const table = document.createElement('table');
    rows.forEach(({ cells }, rowIndex) => {
      const section = rowIndex === 0 ? (table.tHead ?? table.createTHead()) : (table.tBodies[0] ?? table.createTBody());
      const row = section.insertRow();
      cells.forEach(({ value, position }) => {
        const cell = rowIndex === 0 ? document.createElement('th') : document.createElement('td');
        cell.textContent = value || '\u00a0'; cell.dataset.position = String(position); cell.dataset.length = String(value.length);
        cell.addEventListener('mousedown', event => {
          event.preventDefault(); event.stopPropagation();
          const offset = characterOffsetAtX(cell, event.clientX, value.length);
          const targetPosition = position + offset;
          editorView.dispatch({ selection: { anchor: targetPosition }, scrollIntoView: true });
          editorView.requestMeasure(); editorView.focus();
          requestAnimationFrame(() => {
            if (!editorView.dom.isConnected) return;
            editorView.dispatch({ selection: { anchor: Math.min(targetPosition, editorView.state.doc.length) }, scrollIntoView: true });
            editorView.focus();
          });
        });
        row.appendChild(cell);
      });
    });
    wrapper.appendChild(table); return wrapper;
  }
  ignoreEvent(): boolean { return false; }
}

function characterOffsetAtX(cell: HTMLElement, clientX: number, maximum: number): number {
  const textNode = cell.firstChild;
  if (!(textNode instanceof Text) || maximum === 0) return 0;
  const range = document.createRange();
  let closest = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset <= maximum; offset++) {
    range.setStart(textNode, Math.min(offset, textNode.length)); range.collapse(true);
    const currentDistance = Math.abs(range.getBoundingClientRect().left - clientX);
    if (currentDistance < distance) { distance = currentDistance; closest = offset; }
  }
  return closest;
}

function documentPositionAtPoint(editorView: EditorView, clientX: number, clientY: number): number | null {
  const bounds = editorView.contentDOM.getBoundingClientRect();
  const hasLayout = bounds.width > 0 && bounds.height > 0;
  const visibleTop = Math.max(bounds.top + 1, 1);
  const visibleBottom = Math.min(bounds.bottom - 1, window.innerHeight - 1);
  const x = hasLayout ? Math.min(Math.max(clientX, bounds.left + 1), bounds.right - 1) : clientX;
  const y = hasLayout && visibleBottom >= visibleTop ? Math.min(Math.max(clientY, visibleTop), visibleBottom) : clientY;
  const caretDocument = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const caret = caretDocument.caretPositionFromPoint?.(x, y);
  try {
    if (caret) return editorView.posAtDOM(caret.offsetNode, caret.offset);
    const range = caretDocument.caretRangeFromPoint?.(x, y);
    if (range) return editorView.posAtDOM(range.startContainer, range.startOffset);
  } catch { /* Fall back to CodeMirror's coordinate map. */ }
  return editorView.posAtCoords({ x, y }) ?? editorView.posAtCoords({ x, y }, false);
}

function isTableScrollbarClick(table: HTMLElement, clientY: number): boolean {
  const scrollbarHeight = table.offsetHeight - table.clientHeight;
  if (scrollbarHeight <= 0) return false;
  return clientY >= table.getBoundingClientRect().bottom - scrollbarHeight;
}

class CodeCopyWidget extends WidgetType {
  constructor(private readonly code: string) { super(); }
  eq(other: CodeCopyWidget): boolean { return this.code === other.code; }
  toDOM(): HTMLElement {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'copy-code'; button.title = 'Copy code to clipboard'; button.setAttribute('aria-label', 'Copy code to clipboard');
    const copyIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.25" y="2.25" width="8.5" height="8.5" rx="1.25"/><rect x="2.25" y="5.25" width="8.5" height="8.5" rx="1.25"/></svg>';
    const successIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.25 6.4 11.5 13 4.75"/></svg>';
    button.innerHTML = copyIcon;
    button.addEventListener('mousedown', event => event.stopPropagation());
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation(); vscode.postMessage({ type: 'copyText', text: this.code });
      button.classList.add('is-copied'); button.innerHTML = successIcon; button.title = 'Copied';
      window.setTimeout(() => { if (button.isConnected) { button.classList.remove('is-copied'); button.innerHTML = copyIcon; button.title = 'Copy code to clipboard'; } }, 900);
    });
    return button;
  }
  ignoreEvent(): boolean { return true; }
}

function splitTableRow(line: string, absoluteStart: number): Array<{ value: string; position: number }> {
  const firstPipe = line.indexOf('|');
  const contentStart = firstPipe >= 0 ? firstPipe + 1 : 0;
  const contentEnd = line.lastIndexOf('|') > contentStart ? line.lastIndexOf('|') : line.length;
  const content = line.slice(contentStart, contentEnd);
  const cells: Array<{ value: string; position: number }> = [];
  let offset = 0;
  for (const raw of content.split('|')) {
    const leading = raw.match(/^\s*/)?.[0].length ?? 0;
    cells.push({ value: raw.trim(), position: absoluteStart + contentStart + offset + leading });
    offset += raw.length + 1;
  }
  return cells;
}

const livePreview = ViewPlugin.fromClass(class {
  decorations;
  constructor(view: EditorView) { this.decorations = safeBuildDecorations(view); }
  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      this.decorations = safeBuildDecorations(update.view);
    }
  }
}, { decorations: plugin => plugin.decorations });

interface TableDecorationState { decorations: DecorationSet; active?: { from: number; to: number } }

const tableDecorations = StateField.define<TableDecorationState>({
  create(state) {
    const active = findBlockWidgetRange(state, state.selection.main.head);
    return { active, decorations: safeBuildTableDecorations(state, active) };
  },
  update(value, transaction) {
    let active = value.active;
    if (active && transaction.docChanged) active = { from: transaction.changes.mapPos(active.from, -1), to: transaction.changes.mapPos(active.to, -1) };
    const cursor = transaction.state.selection.main.head;
    const parsed = findBlockWidgetRange(transaction.state, cursor);
    if (parsed) active = parsed;
    else if (active && (cursor < active.from || cursor >= active.to)) active = undefined;
    return { active, decorations: safeBuildTableDecorations(transaction.state, active) };
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations)
});

function buildTableDecorations(state: EditorState, active?: { from: number; to: number }): DecorationSet {
  const ranges: ReturnType<Decoration['range']>[] = [];
  syntaxTree(state).iterate({ enter(node) {
    if (node.name !== 'Table' && node.name !== 'HTMLBlock') return;
    const isActive = active && node.from >= active.from && node.to <= active.to;
    if (!isActive) {
      const source = state.doc.sliceString(node.from, node.to);
      const widget = node.name === 'Table' ? new TableWidget(source, node.from) : new HtmlWidget(source, node.from, true);
      ranges.push(Decoration.replace({ widget, block: true }).range(node.from, node.to));
    }
    return false;
  }});
  return Decoration.set(ranges, true);
}

const reportedRenderErrors = new Set<string>();

function reportRenderError(area: string, error: unknown): void {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
  console.error(`MDominate ${area} error:`, error);
  const key = `${area}:${message}`;
  if (reportedRenderErrors.has(key)) return;
  if (reportedRenderErrors.size >= 50) reportedRenderErrors.delete(reportedRenderErrors.values().next().value!);
  reportedRenderErrors.add(key);
  vscode.postMessage({ type: 'rendererError', area, message });
}

function safeBuildTableDecorations(state: EditorState, active?: { from: number; to: number }): DecorationSet {
  try { return buildTableDecorations(state, active); }
  catch (error) { reportRenderError('block renderer', error); return Decoration.none; }
}

function safeBuildDecorations(view: EditorView): DecorationSet {
  try { return buildDecorations(view); }
  catch (error) { reportRenderError('inline renderer', error); return Decoration.none; }
}

function buildDecorations(view: EditorView) {
  const cursor = view.state.selection.main.head;
  const activeRanges = activeSyntaxRanges(view.state);
  const activeQuoteLines = selectedLineNumbers(view.state);
  const additions: Array<{ from: number; to: number; decoration: Decoration }> = [];
  const imageRanges = new Set<string>();
  const listMarkRanges = new Set<string>();
  const references = collectLinkReferences(view.state);
  syntaxTree(view.state).iterate({ enter(node) {
    let cachedText: string | undefined;
    const text = () => cachedText ??= view.state.doc.sliceString(node.from, node.to);
    const isActive = activeRanges.some(range => node.from >= range.from && node.to <= range.to);
    if (node.name === 'Table' || node.name === 'HTMLBlock') return false;
    if (node.name === 'LinkReference') {
      if (!isActive) additions.push({ from: node.from, to: node.from, decoration: Decoration.line({ class: 'cm-link-reference-line' }) });
      return false;
    }
    const inlineHtml = node.name === 'Paragraph' && node.to - node.from <= 10_000 ? text() : '';
    if (node.name === 'Paragraph' && !isActive && !inlineHtml.includes('\n') && /<\/?[A-Za-z][\w-]*(?:\s[^>]*)?\/?>/.test(inlineHtml)) {
      additions.push({ from: node.from, to: node.to, decoration: Decoration.replace({ widget: new HtmlWidget(inlineHtml, node.from, false) }) });
      return false;
    }
    if (node.name === 'Image' && !isActive) {
      imageRanges.add(`${node.from}:${node.to}`);
      const image = parseImage(text(), references);
      if (image) additions.push({ from: node.from, to: node.to, decoration: Decoration.replace({ widget: new ImageWidget(image.href, image.label, image.title, node.from) }) });
      return false;
    }
    if (node.name === 'Image') imageRanges.add(`${node.from}:${node.to}`);
    if (node.name === 'Autolink' && !isActive) {
      const label = text().slice(1, -1);
      additions.push({ from: node.from, to: node.to, decoration: Decoration.replace({ widget: new LinkWidget(label, normaliseAutolinkHref(label), '', node.from) }) });
      return false;
    }
    if (node.name === 'Link' && !isActive) {
      const link = parseLink(text(), references);
      if (link) additions.push({ from: node.from, to: node.to, decoration: Decoration.replace({ widget: new LinkWidget(link.label, link.href, link.title, node.from) }) });
      return false;
    }
    if (node.name === 'URL' && node.node.parent?.name === 'Paragraph' && !isActive) {
      const url = text();
      additions.push({ from: node.from, to: node.to, decoration: Decoration.replace({ widget: new LinkWidget(url, normaliseAutolinkHref(url), '', node.from) }) });
      return false;
    }
    if (node.name === 'HorizontalRule' && !isActive) {
      additions.push({ from: node.from, to: node.to, decoration: Decoration.replace({ widget: new HorizontalRuleWidget(node.from) }) });
      return false;
    }
    const pendingBullet = node.name === 'HeaderMark' && node.node.parent?.name === 'SetextHeading2' && text().trim() === '-' && view.state.selection.ranges.every(range => range.empty);
    if (pendingBullet) {
      additions.push({ from: node.from, to: node.to, decoration: Decoration.replace({ widget: new TextWidget('•', 'cm-list-marker') }) });
      return;
    }
    if (node.name === 'HeaderMark' && !isActive) {
      let end = node.to;
      const lineEnd = view.state.doc.lineAt(node.to).to;
      while (end < lineEnd && /\s/.test(view.state.doc.sliceString(end, end + 1))) end++;
      const setext = /^SetextHeading[12]$/.test(node.node.parent?.name ?? '');
      if (setext) additions.push({ from: view.state.doc.lineAt(node.from).from, to: view.state.doc.lineAt(node.from).from, decoration: Decoration.line({ class: 'cm-setext-marker-line' }) });
      additions.push({ from: node.from, to: end, decoration: Decoration.replace({}) });
    }
    if (node.name === 'EmphasisMark' || node.name === 'StrikethroughMark' || node.name === 'CodeMark' || node.name === 'CodeInfo') {
      if (!isActive) additions.push({ from: node.from, to: node.to, decoration: Decoration.replace({}) });
    }
    if (node.name === 'ListMark') {
      listMarkRanges.add(`${node.from}:${node.to}`);
      const line = view.state.doc.lineAt(node.from).text;
      const taskItem = /^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]/.test(line);
      const markerText = text();
      const ordered = /^\d+[.)]$/.test(markerText);
      const emptyItem = line.slice(node.to - view.state.doc.lineAt(node.from).from).trim() === '';
      if (!isActive || emptyItem) additions.push({ from: node.from, to: node.to, decoration: Decoration.replace(taskItem ? {} : { widget: new TextWidget(ordered ? markerText : '•', 'cm-list-marker') }) });
    }
    if (node.name === 'TaskMarker') {
      const checked = /^\[x\]$/i.test(text());
      if (!isActive) additions.push({ from: node.from, to: node.to, decoration: Decoration.replace({ widget: new TaskWidget(checked, node.from, node.to) }) });
      if (checked) {
        const line = view.state.doc.lineAt(node.from);
        const item = line.text.match(/^(\s*(?:[-+*]|\d+[.)])\s+\[x\]\s+)(.*)$/i);
        if (item?.[2]) {
          const contentFrom = line.from + item[1].length;
          additions.push({ from: contentFrom, to: line.to, decoration: Decoration.mark({ class: 'cm-task-completed-text' }) });
        }
      }
    }
    if (node.name === 'ATXHeading1') additions.push({ from: node.from, to: node.to, decoration: Decoration.mark({ class: 'cm-md-heading-1' }) });
    if (node.name === 'ATXHeading2') additions.push({ from: node.from, to: node.to, decoration: Decoration.mark({ class: 'cm-md-heading-2' }) });
    if (node.name === 'ATXHeading3') additions.push({ from: node.from, to: node.to, decoration: Decoration.mark({ class: 'cm-md-heading-3' }) });
    if (node.name === 'ATXHeading4') additions.push({ from: node.from, to: node.to, decoration: Decoration.mark({ class: 'cm-md-heading-4' }) });
    if (node.name === 'ATXHeading5') additions.push({ from: node.from, to: node.to, decoration: Decoration.mark({ class: 'cm-md-heading-5' }) });
    if (node.name === 'ATXHeading6') additions.push({ from: node.from, to: node.to, decoration: Decoration.mark({ class: 'cm-md-heading-6' }) });
    if (node.name === 'SetextHeading1') additions.push({ from: node.from, to: node.to, decoration: Decoration.mark({ class: 'cm-md-heading-1' }) });
    if (node.name === 'SetextHeading2' && !isSingleDashSetext(view.state, node.from, node.to)) additions.push({ from: node.from, to: node.to, decoration: Decoration.mark({ class: 'cm-md-heading-2' }) });
    if (node.name === 'StrongEmphasis') additions.push({ from: node.from, to: node.to, decoration: Decoration.mark({ class: 'cm-md-strong' }) });
    if (node.name === 'Emphasis') additions.push({ from: node.from, to: node.to, decoration: Decoration.mark({ class: 'cm-md-emphasis' }) });
    if (node.name === 'Strikethrough') additions.push({ from: node.from, to: node.to, decoration: Decoration.mark({ class: 'cm-md-strikethrough' }) });
    if (node.name === 'InlineCode') additions.push({ from: node.from, to: node.to, decoration: Decoration.mark({ class: 'cm-md-inline-code' }) });
    if (node.name === 'FencedCode') {
      additions.push({ from: node.from, to: node.to, decoration: Decoration.mark({ class: 'cm-md-codeblock' }) });
      addBlockLines(view, additions, node.from, node.to, 'cm-md-code-line', 'cm-md-code-first', 'cm-md-code-last');
      const code = text().replace(/^(?:```|~~~)[^\n]*\n?/, '').replace(/\n?(?:```|~~~)\s*$/, '');
      const firstLine = view.state.doc.lineAt(node.from);
      additions.push({ from: firstLine.to, to: firstLine.to, decoration: Decoration.widget({ widget: new CodeCopyWidget(code), side: 1 }) });
    }
    if (node.name === 'CodeBlock') {
      additions.push({ from: node.from, to: node.to, decoration: Decoration.mark({ class: 'cm-md-codeblock' }) });
      addBlockLines(view, additions, node.from, node.to, 'cm-md-code-line', 'cm-md-code-first', 'cm-md-code-last');
      if (!isActive) hideIndentedCodePrefixes(view, additions, node.from, node.to);
      const code = indentedCodeText(view.state, node.from, node.to);
      const firstLine = view.state.doc.lineAt(node.from);
      additions.push({ from: firstLine.to, to: firstLine.to, decoration: Decoration.widget({ widget: new CodeCopyWidget(code), side: 1 }) });
    }
    if (node.name === 'Blockquote' && node.node.parent?.name !== 'Blockquote') addQuoteLines(view, additions, node.from, node.to);
    const quoteMarkOnActiveLine = node.name === 'QuoteMark' && activeQuoteLines.has(view.state.doc.lineAt(node.from).number);
    if (node.name === 'QuoteMark' && !isActive && !quoteMarkOnActiveLine) {
      let end = node.to;
      const lineEnd = view.state.doc.lineAt(node.to).to;
      while (end < lineEnd && /\s/.test(view.state.doc.sliceString(end, end + 1))) end++;
      additions.push({ from: node.from, to: end, decoration: Decoration.replace({}) });
    }
    if (node.name === 'Escape' && !isActive) additions.push({ from: node.from, to: node.from + 1, decoration: Decoration.replace({}) });
    if (node.name === 'HardBreak' && !isActive) additions.push({ from: node.from, to: Math.max(node.from, node.to - 1), decoration: Decoration.replace({}) });
  }});
  for (const image of documentMetadata(view.state).dataImages) {
    const { from, to } = image;
    if (!imageRanges.has(`${from}:${to}`) && !(cursor >= from && cursor < to)) additions.push({ from, to, decoration: Decoration.replace({ widget: new ImageWidget(image.source, image.alt, '', from) }) });
  }
  for (const emptyItem of documentMetadata(view.state).emptyListItems) {
    const { from, to } = emptyItem;
    if (!listMarkRanges.has(`${from}:${to}`)) {
      const ordered = /^\d/.test(emptyItem.marker);
      additions.push({ from, to, decoration: Decoration.replace({ widget: new TextWidget(ordered ? emptyItem.marker : '•', 'cm-list-marker') }) });
    }
  }
  // Decorations can come from a document-wide fallback pass (for empty list items),
  // so let CodeMirror sort them instead of assuming syntax-tree order.
  return Decoration.set(additions.map(item => item.decoration.range(item.from, item.to)), true);
}

interface LinkTarget { label: string; href: string; title: string }

interface DocumentMetadata {
  references: Map<string, { href: string; title: string }>;
  dataImages: Array<{ from: number; to: number; alt: string; source: string }>;
  emptyListItems: Array<{ from: number; to: number; marker: string }>;
}

let metadataDocument: object | undefined;
let cachedMetadata: DocumentMetadata | undefined;

function documentMetadata(state: EditorState): DocumentMetadata {
  if (metadataDocument === state.doc && cachedMetadata) return cachedMetadata;
  const source = state.doc.toString();
  const references = new Map<string, { href: string; title: string }>();
  const definition = /^\s{0,3}\[([^\]]+)\]:[ \t]*(?:<([^>]+)>|(\S+))(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/gm;
  for (const match of source.matchAll(definition)) references.set(normaliseReference(match[1]), { href: match[2] ?? match[3], title: match[4] ?? match[5] ?? match[6] ?? '' });
  const dataImages: DocumentMetadata['dataImages'] = [];
  for (const match of source.matchAll(/!\[([^\]\n]*)\]\((data:image\/[^\s)]+)\)/g)) {
    const from = match.index ?? 0;
    dataImages.push({ from, to: from + match[0].length, alt: match[1], source: match[2] });
  }
  const emptyListItems: DocumentMetadata['emptyListItems'] = [];
  for (const match of source.matchAll(/^([ \t]*)([-+*]|\d+[.)])[ \t]+$/gm)) {
    const from = (match.index ?? 0) + match[1].length;
    emptyListItems.push({ from, to: from + match[2].length, marker: match[2] });
  }
  metadataDocument = state.doc;
  return cachedMetadata = { references, dataImages, emptyListItems };
}

function collectLinkReferences(state: EditorState): Map<string, { href: string; title: string }> {
  return documentMetadata(state).references;
}

function normaliseReference(label: string): string { return label.trim().replace(/\s+/g, ' ').toLowerCase(); }

function parseDestination(source: string): { href: string; title: string } | undefined {
  const match = source.match(/^\s*(?:<([^>]+)>|(\S+?))(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*$/s);
  if (!match) return undefined;
  return { href: match[1] ?? match[2], title: match[3] ?? match[4] ?? match[5] ?? '' };
}

function parseImage(source: string, references: Map<string, { href: string; title: string }>): LinkTarget | undefined {
  const inline = source.match(/^!\[([^\]]*)\]\((.*)\)$/s);
  if (inline) {
    const target = parseDestination(inline[2]);
    return target ? { label: inline[1], ...target } : undefined;
  }
  const fullReference = source.match(/^!\[([^\]]*)\]\[([^\]]*)\]$/s);
  if (fullReference) {
    const target = references.get(normaliseReference(fullReference[2] || fullReference[1]));
    return target ? { label: fullReference[1], ...target } : undefined;
  }
  const shortcut = source.match(/^!\[([^\]]+)\]$/s);
  if (shortcut) {
    const target = references.get(normaliseReference(shortcut[1]));
    return target ? { label: shortcut[1], ...target } : undefined;
  }
  return undefined;
}

function normaliseAutolinkHref(value: string): string {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `mailto:${value}`;
  if (/^www\./i.test(value)) return `https://${value}`;
  return value;
}

function parseLink(source: string, references: Map<string, { href: string; title: string }>): LinkTarget | undefined {
  const inline = source.match(/^\[([^\]]+)\]\((.*)\)$/s);
  if (inline) {
    const target = parseDestination(inline[2]);
    return target ? { label: inline[1], ...target } : undefined;
  }
  const fullReference = source.match(/^\[([^\]]+)\]\[([^\]]*)\]$/s);
  if (fullReference) {
    const target = references.get(normaliseReference(fullReference[2] || fullReference[1]));
    return target ? { label: fullReference[1], ...target } : undefined;
  }
  const shortcut = source.match(/^\[([^\]]+)\]$/s);
  if (shortcut) {
    const target = references.get(normaliseReference(shortcut[1]));
    return target ? { label: shortcut[1], ...target } : undefined;
  }
  return undefined;
}

function hideIndentedCodePrefixes(view: EditorView, additions: Array<{ from: number; to: number; decoration: Decoration }>, from: number, to: number): void {
  let line = view.state.doc.lineAt(from);
  const lastLine = view.state.doc.lineAt(to);
  while (true) {
    const prefix = line.text.match(/^(?: {4}|\t)/)?.[0];
    if (prefix) additions.push({ from: line.from, to: line.from + prefix.length, decoration: Decoration.replace({}) });
    if (line.number >= lastLine.number) break;
    line = view.state.doc.line(line.number + 1);
  }
}

function indentedCodeText(state: EditorState, from: number, to: number): string {
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  const lines: string[] = [];
  for (let number = first; number <= last; number++) lines.push(state.doc.line(number).text.replace(/^(?: {4}|\t)/, ''));
  return lines.join('\n');
}

function addBlockLines(view: EditorView, additions: Array<{ from: number; to: number; decoration: Decoration }>, from: number, to: number, base: string, first: string, last: string): void {
  let line = view.state.doc.lineAt(from);
  const lastLine = view.state.doc.lineAt(to);
  const firstLineNumber = line.number;
  while (true) {
    const extra = `${line.number === firstLineNumber ? ` ${first}` : ''}${line.number === lastLine.number ? ` ${last}` : ''}`;
    additions.push({ from: line.from, to: line.from, decoration: Decoration.line({ class: `${base}${extra}` }) });
    if (line.number >= lastLine.number) break;
    line = view.state.doc.line(line.number + 1);
  }
}

function addQuoteLines(view: EditorView, additions: Array<{ from: number; to: number; decoration: Decoration }>, from: number, to: number): void {
  let line = view.state.doc.lineAt(from);
  const lastLine = view.state.doc.lineAt(to);
  while (true) {
    const quotePrefix = line.text.match(/^(?:\s*>\s*)+/)?.[0] ?? '>';
    const depth = Math.min(4, Math.max(1, (quotePrefix.match(/>/g) ?? []).length));
    const edges = `${line.number === view.state.doc.lineAt(from).number ? ' cm-quote-first' : ''}${line.number === lastLine.number ? ' cm-quote-last' : ''}`;
    additions.push({ from: line.from, to: line.from, decoration: Decoration.line({ class: `cm-quote-line cm-quote-depth-${depth}${edges}` }) });
    if (line.number >= lastLine.number) break;
    line = view.state.doc.line(line.number + 1);
  }
}

function activeSyntaxRange(state: EditorState, cursor: number): { from: number; to: number } | undefined {
  let selected: { from: number; to: number; size: number } | undefined;
  let emphasis: { from: number; to: number; size: number } | undefined;
  let fencedCode: { from: number; to: number } | undefined;
  let heading: { from: number; to: number } | undefined;
  let html: { from: number; to: number } | undefined;
  syntaxTree(state).iterate({ enter(node) {
    if ((node.name === 'FencedCode' || node.name === 'CodeBlock') && state.doc.lineAt(node.from).from <= cursor && node.to >= cursor) { fencedCode = { from: state.doc.lineAt(node.from).from, to: node.to }; return; }
    if (/^(?:ATXHeading[1-6]|SetextHeading[12])$/.test(node.name) && node.from <= cursor && node.to >= cursor) {
      if (node.name !== 'SetextHeading2' || !isSingleDashSetext(state, node.from, node.to)) heading = { from: node.from, to: node.to };
      return;
    }
    if (node.name === 'Paragraph' && node.from <= cursor && node.to >= cursor && /<\/?[A-Za-z][\w-]*(?:\s[^>]*)?\/?>/.test(state.doc.sliceString(node.from, node.to))) { html = { from: node.from, to: node.to }; return; }
    if (node.from > cursor || node.to <= cursor) return;
    const tableSeparator = node.name === 'TableDelimiter' && node.node.parent?.name === 'Table';
    const bareUrl = node.name === 'URL' && node.node.parent?.name === 'Paragraph';
    if (!tableSeparator && !bareUrl && !['StrongEmphasis', 'Emphasis', 'Strikethrough', 'InlineCode', 'Escape', 'HardBreak', 'ListItem', 'Image', 'Link', 'Autolink', 'LinkReference', 'HorizontalRule', 'ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6', 'SetextHeading1', 'SetextHeading2', 'HTMLBlock'].includes(node.name)) return;
    const size = node.to - node.from;
    if (node.name === 'StrongEmphasis' || node.name === 'Emphasis') {
      if (!emphasis || size > emphasis.size) emphasis = { from: node.from, to: node.to, size };
      return;
    }
    if (!selected || size < selected.size) selected = { from: node.from, to: node.to, size };
  }});
  return fencedCode ?? heading ?? html ?? emphasis ?? selected;
}

function isSingleDashSetext(state: EditorState, from: number, to: number): boolean {
  const lastLine = state.doc.lineAt(Math.max(from, to - 1));
  return lastLine.text.trim() === '-';
}

function activeSyntaxRanges(state: EditorState): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const selection of state.selection.ranges) {
    if (selection.empty) {
      const active = activeSyntaxRange(state, selection.head);
      if (active) ranges.push(active);
      continue;
    }
    syntaxTree(state).iterate({ enter(node) {
      if (node.to <= selection.from || node.from >= selection.to) return;
      const supported = /^(?:ATXHeading[1-6]|SetextHeading[12]|FencedCode|CodeBlock|StrongEmphasis|Emphasis|Strikethrough|InlineCode|ListItem|Image|Link|Autolink|LinkReference|HorizontalRule|HTMLBlock)$/.test(node.name);
      if (supported) ranges.push({ from: state.doc.lineAt(node.from).from <= selection.from && /^(?:FencedCode|CodeBlock)$/.test(node.name) ? state.doc.lineAt(node.from).from : node.from, to: node.to });
    }});
  }
  return ranges;
}

function selectedLineNumbers(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const selection of state.selection.ranges) {
    const first = state.doc.lineAt(selection.from).number;
    const lastPosition = selection.empty ? selection.head : Math.max(selection.from, selection.to - 1);
    const last = state.doc.lineAt(lastPosition).number;
    for (let number = first; number <= last; number++) lines.add(number);
  }
  return lines;
}

function findBlockWidgetRange(state: EditorState, cursor: number): { from: number; to: number } | undefined {
  let table: { from: number; to: number } | undefined;
  const selection = state.selection.main;
  syntaxTree(state).iterate({ enter(node) {
    const intersects = selection.empty ? node.from <= cursor && cursor < node.to : node.from < selection.to && node.to > selection.from;
    if ((node.name === 'Table' || node.name === 'HTMLBlock') && intersects) table = { from: node.from, to: node.to };
  }});
  return table;
}

function slashCompletions(context: CompletionContext) {
  const token = context.matchBefore(/\/[^\s/]*/);
  if (!token) return null;
  const line = context.state.doc.lineAt(token.from);
  if (token.from > line.from && !/\s/.test(context.state.doc.sliceString(token.from - 1, token.from))) return null;
  const options: Completion[] = [
    { label: '/todo', type: 'keyword', detail: 'Task item', apply: '- [ ] ' },
    { label: '/bullet', type: 'keyword', detail: 'Bullet list item', apply: '- ' },
    { label: '/numbered', type: 'keyword', detail: 'Numbered list item', apply: '1. ' },
    { label: '/quote', type: 'keyword', detail: 'Block quote', apply: '> ' },
    { label: '/line', type: 'keyword', detail: 'Horizontal rule', apply: '---\n' },
    { label: '/code', type: 'keyword', detail: 'Fenced code block', apply: insertCodeBlock },
    { label: '/table', type: 'keyword', detail: 'Table', apply: insertDefaultTable }
  ];
  return { from: token.from, options, validFor: /^\/[\w-]*$/ };
}

function insertDefaultTable(editorView: EditorView, _completion: Completion, from: number, to: number): void {
  const table = createTable(2, 2);
  editorView.dispatch({ changes: { from, to, insert: table }, selection: { anchor: from + 2 } });
}

function createTable(columns: number, rows: number): string {
  const header = `| ${Array.from({ length: columns }, (_, index) => `Column ${index + 1}`).join(' | ')} |`;
  const separator = `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`;
  const body = Array.from({ length: Math.max(0, rows - 1) }, () => `| ${Array.from({ length: columns }, () => ' ').join(' | ')} |`);
  return [header, separator, ...body].join('\n');
}

function insertCodeBlock(editorView: EditorView, _completion: Completion, from: number, to: number): void {
  const source = '```\n\n```';
  editorView.dispatch({ changes: { from, to, insert: source }, selection: { anchor: from + 4 } });
}

function expandDimensionCommand(editorView: EditorView): boolean {
  const cursor = editorView.state.selection.main.head;
  const line = editorView.state.doc.lineAt(cursor);
  if (cursor !== line.to) return false;
  const match = line.text.match(/^(\s*)\/(\d{1,2})x(\d{1,2})$/i);
  if (!match) return false;
  const columns = Math.min(12, Math.max(1, Number(match[2])));
  const rows = Math.min(12, Math.max(2, Number(match[3])));
  const from = line.from + match[1].length;
  const table = createTable(columns, rows);
  editorView.dispatch({ changes: { from, to: line.to, insert: table }, selection: { anchor: from + 2 } });
  return true;
}

function indentListItem(editorView: EditorView, outdent: boolean): boolean {
  const selection = editorView.state.selection.main;
  const first = editorView.state.doc.lineAt(selection.from);
  const last = editorView.state.doc.lineAt(selection.to);
  const changes: Array<{ from: number; to?: number; insert: string }> = [];
  for (let number = first.number; number <= last.number; number++) {
    const line = editorView.state.doc.line(number);
    const item = line.text.match(/^(\s*)((?:[-+*]|\d+[.)]))\s+/);
    if (!item) return false;
    const currentIndent = item[1].length;
    if (outdent) {
      if (!currentIndent) continue;
      let targetIndent = 0;
      for (let previous = number - 1; previous >= 1; previous--) {
        const previousLine = editorView.state.doc.line(previous);
        const previousItem = previousLine.text.match(/^(\s*)(?:[-+*]|\d+[.)])\s+/);
        if (previousItem && previousItem[1].length < currentIndent) { targetIndent = previousItem[1].length; break; }
      }
      changes.push({ from: line.from, to: line.from + currentIndent, insert: ' '.repeat(targetIndent) });
    } else {
      let targetIndent = currentIndent + Math.max(2, item[2].length + 1);
      if (number > 1) {
        const previousLine = editorView.state.doc.line(number - 1);
        const previousItem = previousLine.text.match(/^(\s*)((?:[-+*]|\d+[.)]))\s+/);
        if (previousItem) targetIndent = Math.max(targetIndent, previousItem[1].length + previousItem[2].length + 1);
      }
      if (/^\d+[.)]$/.test(item[2])) {
        const resetMarker = item[2].endsWith(')') ? '1)' : '1.';
        changes.push({ from: line.from, to: line.from + currentIndent + item[2].length, insert: `${' '.repeat(targetIndent)}${resetMarker}` });
      } else changes.push({ from: line.from, to: line.from + currentIndent, insert: ' '.repeat(targetIndent) });
    }
  }
  if (!changes.length) return outdent;
  editorView.dispatch({ changes }); return true;
}

function continueListItem(editorView: EditorView): boolean {
  const selection = editorView.state.selection.main;
  if (!selection.empty) return false;
  const line = editorView.state.doc.lineAt(selection.head);
  const match = line.text.match(/^(\s*)((?:>\s*)*)([-+*]|(\d+)([.)]))\s+(\[[ xX]\]\s+)?(.*)$/);
  if (!match) return false;
  const content = match[7];
  const contentStart = line.from + line.text.length - content.length;
  if (!content.trim()) {
    editorView.dispatch({ changes: { from: line.from, to: line.to, insert: '' } });
    return true;
  }
  const quoteDepth = (match[2].match(/>/g) ?? []).length;
  const quote = quoteDepth ? `${'>'.repeat(quoteDepth)} ` : '';
  const marker = match[4] ? `${Number(match[4]) + 1}${match[5]}` : match[3];
  const task = match[6] ? '[ ] ' : '';
  const insertAt = selection.head < contentStart ? line.to : selection.head;
  const prefix = `${match[1]}${quote}${marker} ${task}`;
  const continuation = `\n${prefix}`;
  editorView.dispatch({ changes: { from: insertAt, insert: continuation }, selection: { anchor: insertAt + continuation.length } });
  scheduleListGapRepair(editorView, line.number, prefix);
  return true;
}

function scheduleListGapRepair(editorView: EditorView, previousLineNumber: number, prefix: string): void {
  queueMicrotask(() => {
    if (!editorView.dom.isConnected || previousLineNumber + 2 > editorView.state.doc.lines) return;
    const previous = editorView.state.doc.line(previousLineNumber);
    const possibleGap = editorView.state.doc.line(previousLineNumber + 1);
    const continuation = editorView.state.doc.line(previousLineNumber + 2);
    if (possibleGap.text.trim() || !continuation.text.startsWith(prefix)) return;
    editorView.dispatch({
      changes: { from: previous.to, to: possibleGap.to + 1, insert: '\n' },
      selection: { anchor: Math.max(continuation.from - 1, previous.to + 1) + prefix.length }
    });
  });
}

function continueQuote(editorView: EditorView): boolean {
  const selection = editorView.state.selection.main;
  if (!selection.empty) return false;
  const line = editorView.state.doc.lineAt(selection.head);
  const match = line.text.match(/^(\s*)((?:>\s*)+)(.*)$/);
  if (!match) return false;
  const depth = (match[2].match(/>/g) ?? []).length;
  const contentStart = line.from + line.text.length - match[3].length;
  const insertAt = selection.head < contentStart ? line.to : selection.head;
  const continuation = `\n${match[1]}${'>'.repeat(depth)} `;
  editorView.dispatch({ changes: { from: insertAt, insert: continuation }, selection: { anchor: insertAt + continuation.length } });
  return true;
}

function handleEnter(editorView: EditorView): boolean {
  if (completionStatus(editorView.state) === 'active' && acceptCompletion(editorView)) return true;
  return expandDimensionCommand(editorView) || continueListItem(editorView) || continueQuote(editorView) || insertNewlineAndIndent(editorView);
}

function moveByDocumentLine(editorView: EditorView, direction: -1 | 1): boolean {
  if (completionStatus(editorView.state)) return false;
  const selection = editorView.state.selection.main;
  if (!selection.empty) return false;
  const current = editorView.state.doc.lineAt(selection.head);
  const targetNumber = current.number + direction;
  if (targetNumber < 1 || targetNumber > editorView.state.doc.lines) return false;
  const target = editorView.state.doc.line(targetNumber);
  const column = selection.head - current.from;
  editorView.dispatch({ selection: { anchor: Math.min(target.from + column, target.to) }, scrollIntoView: true });
  return true;
}

const view = new EditorView({
  state: EditorState.create({ doc: '', extensions: [markdown({ extensions: [GFM], addKeymap: false }), history(), closeBrackets(), autocompletion({ override: [slashCompletions], activateOnTyping: true, icons: false }), keymap.of([...completionKeymap.filter(binding => binding.key !== 'Enter'), { key: 'Mod-z', run: undo }, { key: 'Mod-y', run: redo }, { key: 'Mod-Shift-z', run: redo }, { key: 'ArrowUp', run: view => moveByDocumentLine(view, -1) }, { key: 'ArrowDown', run: view => moveByDocumentLine(view, 1) }, { key: 'Tab', run: view => indentListItem(view, false) }, { key: 'Shift-Tab', run: view => indentListItem(view, true) }, ...closeBracketsKeymap, ...defaultKeymap.filter(binding => binding.key !== 'Enter'), ...historyKeymap]), tableDecorations, livePreview, EditorView.lineWrapping, EditorView.updateListener.of(update => {
    if (!update.docChanged) return;
    for (const [requestId, range] of pendingImagePastes) {
      pendingImagePastes.set(requestId, { from: update.changes.mapPos(range.from, -1), to: update.changes.mapPos(range.to, -1) });
    }
    if (!initialised || applyingHostDocument) return;
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push({ from: fromA, to: toA, insert: inserted.toString() }));
    vscode.postMessage({ type: 'update', changes, expectedLength: update.state.doc.length });
  }), EditorView.domEventHandlers({
    keydown(event, editorView) {
      if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;
      if (!handleEnter(editorView)) return false;
      event.preventDefault(); event.stopPropagation(); return true;
    },
    mousedown(event, editorView) {
      if (!(event.target instanceof Element)) return false;
      const target = event.target;
      const tableWidget = target.closest<HTMLElement>('.cm-table-widget');
      if (tableWidget && isTableScrollbarClick(tableWidget, event.clientY)) { event.stopPropagation(); return true; }
      const tableCell = target.closest<HTMLElement>('.cm-table-widget td,.cm-table-widget th');
      if (tableCell?.dataset.position) {
        event.preventDefault();
        editorView.dispatch({ selection: { anchor: Number(tableCell.dataset.position) }, scrollIntoView: true });
        editorView.focus();
        return true;
      }
      const link = target.closest<HTMLElement>('.cm-link-widget');
      if (link?.dataset.href && (event.ctrlKey || event.metaKey)) { vscode.postMessage({ type: 'openLink', href: link.dataset.href }); return true; }
      if (link?.dataset.from) {
        event.preventDefault();
        const labelLength = link.textContent?.length ?? 0;
        const offset = characterOffsetAtX(link, event.clientX, labelLength);
        editorView.dispatch({ selection: { anchor: Number(link.dataset.from) + 1 + offset }, scrollIntoView: true });
        editorView.requestMeasure(); editorView.focus(); return true;
      }
      const rendered = target.closest<HTMLElement>('.cm-image-widget,.cm-link-widget,.cm-horizontal-rule,.cm-table-widget,.cm-html-widget');
      if (rendered?.dataset.from) {
        event.preventDefault();
        editorView.dispatch({ selection: { anchor: Number(rendered.dataset.from) }, scrollIntoView: true }); editorView.focus(); return true;
      }
      if (event.button !== 0 || !target.closest('.cm-content')) return false;
      const position = documentPositionAtPoint(editorView, event.clientX, event.clientY);
      if (position === null) return false;
      event.preventDefault();
      const anchor = event.shiftKey ? editorView.state.selection.main.anchor : position;
      if (event.detail >= 3) {
        const line = editorView.state.doc.lineAt(position);
        editorView.dispatch({ selection: { anchor: line.from, head: line.to }, scrollIntoView: true });
      } else if (event.detail === 2) {
        const word = editorView.state.wordAt(position);
        editorView.dispatch({ selection: word ? { anchor: word.from, head: word.to } : { anchor: position }, scrollIntoView: true });
      } else editorView.dispatch({ selection: { anchor, head: position }, scrollIntoView: true });
      editorView.focus();
      let lastX = event.clientX;
      let lastY = event.clientY;
      let dragging = true;
      let animationFrame = 0;
      const updateDragSelection = () => {
        const head = documentPositionAtPoint(editorView, lastX, lastY);
        if (head !== null) editorView.dispatch({ selection: { anchor, head } });
      };
      const autoScroll = () => {
        if (!dragging) return;
        const edge = 32;
        let delta = 0;
        if (lastY < edge) delta = -Math.max(4, Math.min(28, (edge - lastY) * .7));
        else if (lastY > window.innerHeight - edge) delta = Math.max(4, Math.min(28, (lastY - (window.innerHeight - edge)) * .7));
        if (delta) { window.scrollBy({ top: delta, behavior: 'auto' }); updateDragSelection(); }
        animationFrame = requestAnimationFrame(autoScroll);
      };
      const move = (moveEvent: MouseEvent) => {
        if (!(moveEvent.buttons & 1)) return;
        lastX = moveEvent.clientX; lastY = moveEvent.clientY; updateDragSelection();
      };
      const up = () => { dragging = false; cancelAnimationFrame(animationFrame); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up, { once: true });
      animationFrame = requestAnimationFrame(autoScroll);
      return true;
    },
    paste(event, editorView) {
      const clipboard = event.clipboardData;
      const image = Array.from(clipboard?.files ?? []).find(file => file.type.startsWith('image/'))
        ?? Array.from(clipboard?.items ?? []).find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile();
      if (!image) return false;
      event.preventDefault();
      void toDataUrl(image).then(dataUrl => {
        if (!editorView.dom.isConnected) return;
        if (imagePasteMode === 'base64') {
          editorView.dispatch(editorView.state.replaceSelection(`![pasted image](${dataUrl})`));
          return;
        }
        const requestId = `image-${Date.now()}-${++imagePasteSequence}`;
        const selection = editorView.state.selection.main;
        pendingImagePastes.set(requestId, { from: selection.from, to: selection.to });
        vscode.postMessage({ type: 'savePastedImage', requestId, dataUrl, originalName: image.name });
      }).catch(error => reportRenderError('image paste', error));
      return true;
    },
  })] }),
  parent: host
});

window.addEventListener('message', event => {
  if (!event.data || typeof event.data !== 'object') return;
  const message = event.data as Record<string, unknown>;
  if (message.type === 'config') { imagePasteMode = message.imagePasteMode === 'base64' ? 'base64' : 'assets'; return; }
  if (message.type === 'pastedImageSaved' && typeof message.requestId === 'string' && typeof message.markdown === 'string') {
    const range = pendingImagePastes.get(message.requestId);
    if (!range) return;
    pendingImagePastes.delete(message.requestId);
    const selection = view.state.selection.main;
    const cursorStillWaiting = selection.from === range.from && selection.to === range.to;
    view.dispatch(cursorStillWaiting
      ? { changes: { from: range.from, to: range.to, insert: message.markdown }, selection: { anchor: range.from + message.markdown.length } }
      : { changes: { from: range.from, to: range.to, insert: message.markdown } });
    if (cursorStillWaiting) view.focus();
    return;
  }
  if (message.type === 'pastedImageError' && typeof message.requestId === 'string') {
    pendingImagePastes.delete(message.requestId);
    reportRenderError('image paste', String(message.message ?? 'Could not save the pasted image.'));
    return;
  }
  if (message.type === 'requestSnapshot') { vscode.postMessage({ type: 'snapshot', text: view.state.doc.toString() }); return; }
  if (message.type !== 'document') return;
  const text = String(message.text ?? '');
  documentBase = String(message.documentBase ?? documentBase);
  imagePasteMode = message.imagePasteMode === 'base64' ? 'base64' : 'assets';
  if (view.state.doc.toString() !== text) {
    applyingHostDocument = true;
    try { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: Transaction.addToHistory.of(false) }); }
    finally { applyingHostDocument = false; }
  }
  initialised = true;
});

function toDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
}

window.addEventListener('unhandledrejection', event => {
  reportRenderError('asynchronous operation', event.reason);
  event.preventDefault();
});

window.addEventListener('error', event => {
  reportRenderError('runtime', event.error ?? event.message);
});

vscode.postMessage({ type: 'ready' });
