import { Fragment, Slice, type Mark, type Node as ProseMirrorNode, type ResolvedPos } from '@milkdown/prose/model';
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';

const REVEAL_MARKS = new Set(['link', 'strong', 'emphasis', 'strike_through', 'inlineCode']);

interface MarkRange {
  from: number;
  to: number;
  text: string;
  mark: Mark;
}

export interface LocalSourceToken {
  pos: number;
  side: number;
  text: string;
  kind: 'open' | 'close' | 'image';
}

export interface EditableSourceRegion {
  from: number;
  to: number;
  source: string;
  caret: number;
  image: boolean;
}

interface LocalSourcePluginOptions {
  parseMarkdown(markdown: string): ProseMirrorNode | null | string;
}

interface LocalSourcePluginState {
  suppressedSelection: string | null;
}

const localSourceRevealKey = new PluginKey<LocalSourcePluginState>('mdwLocalSourceReveal');

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/([\[\]])/g, '\\$1');
}

function escapeTitle(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function serializeDestination(value: unknown): string {
  const destination = String(value ?? '');
  if (destination === '' || /[\0- \u007f]/.test(destination)) {
    return `<${destination.replace(/\\/g, '\\\\').replace(/>/g, '\\>')}>`;
  }
  return destination.replace(/\\/g, '\\\\').replace(/[()]/g, '\\$&');
}

function serializeTarget(attrs: Record<string, unknown>): string {
  const destination = serializeDestination(attrs.href ?? attrs.src);
  const title = attrs.title ? ` "${escapeTitle(String(attrs.title))}"` : '';
  return `${destination}${title}`;
}

/** Return the CommonMark code-span delimiter and any required inner padding. */
export function codeSpanMarkers(value: string): [string, string] {
  let fenceLength = 1;
  for (const match of value.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
  const fence = '`'.repeat(fenceLength);
  const needsPadding =
    /[^ \r\n]/.test(value) &&
    ((/^[ \r\n]/.test(value) && /[ \r\n]$/.test(value)) || value.startsWith('`') || value.endsWith('`'));
  const padding = needsPadding ? ' ' : '';
  return [fence + padding, padding + fence];
}

/** Serialize the image node using the same visible shape as the editor's Markdown serializer. */
export function imageSource(node: ProseMirrorNode): string {
  const attrs = node.attrs as Record<string, unknown>;
  const width = attrs.width ? `{width=${String(attrs.width)}}` : '';
  return `![${escapeLabel(String(attrs.alt ?? ''))}](${serializeTarget(attrs)})${width}`;
}

function markMarkers(range: MarkRange): [string, string] | null {
  switch (range.mark.type.name) {
    case 'strong':
      return ['**', '**'];
    case 'emphasis':
      return ['*', '*'];
    case 'strike_through':
      return ['~~', '~~'];
    case 'inlineCode':
      return codeSpanMarkers(range.text);
    case 'link':
      return ['[', `](${serializeTarget(range.mark.attrs)})`];
    default:
      return null;
  }
}

/** Find the complete contiguous run carrying this exact mark around the selection. */
function findMarkRange($pos: ResolvedPos, selectionFrom: number, selectionTo: number, mark: Mark): MarkRange | null {
  const parent = $pos.parent;
  if (!parent.inlineContent) return null;

  const parentStart = $pos.start();
  let runStart = -1;
  let runEnd = -1;
  let runText = '';
  let result: MarkRange | null = null;

  const finishRun = () => {
    if (runStart >= 0 && selectionFrom >= runStart && selectionTo <= runEnd) {
      result = { from: runStart, to: runEnd, text: runText, mark };
    }
    runStart = -1;
    runEnd = -1;
    runText = '';
  };

  parent.forEach((child, offset) => {
    const childStart = parentStart + offset;
    const sameMark = child.marks.some((candidate) => candidate.eq(mark));
    if (!sameMark) {
      finishRun();
      return;
    }
    if (runStart < 0) runStart = childStart;
    runEnd = childStart + child.nodeSize;
    runText += child.textContent;
  });
  finishRun();

  return result;
}

function activeMarkRanges(state: EditorState): MarkRange[] {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || selection.$from.parent !== selection.$to.parent) return [];

  const candidates: Mark[] = [];
  const addMarks = (marks: readonly Mark[]) => {
    for (const mark of marks) {
      if (!REVEAL_MARKS.has(mark.type.name) || candidates.some((candidate) => candidate.eq(mark))) continue;
      candidates.push(mark);
    }
  };

  addMarks(selection.$from.marks());
  // inlineCode is non-inclusive, so its mark can disappear exactly at an edge.
  // Only fall back to neighbouring nodes when the resolved position has no mark,
  // otherwise a boundary between two differently formatted runs would reveal both.
  if (selection.empty && candidates.length === 0) {
    addMarks(selection.$from.nodeBefore?.marks ?? []);
    addMarks(selection.$from.nodeAfter?.marks ?? []);
  }

  return candidates
    .map((mark) => findMarkRange(selection.$from, selection.from, selection.to, mark))
    .filter((range): range is MarkRange => range !== null);
}

function markRank(name: string): number {
  // Opening widgets use this order; closing widgets use the reverse order.
  return ['link', 'strong', 'emphasis', 'strike_through', 'inlineCode'].indexOf(name);
}

export function localSourceTokens(state: EditorState): LocalSourceToken[] {
  const { selection } = state;
  if (selection instanceof NodeSelection && selection.node.type.name === 'image') {
    return [{
      pos: selection.to,
      side: 100,
      text: imageSource(selection.node),
      kind: 'image',
    }];
  }

  const tokens: LocalSourceToken[] = [];
  for (const range of activeMarkRanges(state)) {
    const markers = markMarkers(range);
    if (!markers) continue;
    const rank = markRank(range.mark.type.name);
    tokens.push(
      { pos: range.from, side: -100 + rank, text: markers[0], kind: 'open' },
      { pos: range.to, side: 100 - rank, text: markers[1], kind: 'close' },
    );
  }
  return tokens;
}

function selectionKey(state: EditorState): string {
  return `${state.selection.from}:${state.selection.to}`;
}

function textBetween(state: EditorState, from: number, to: number): string {
  return from < to ? state.doc.textBetween(from, to, '') : '';
}

/** Build one editable Markdown source span for the complete active semantic range. */
export function editableSourceRegion(state: EditorState): EditableSourceRegion | null {
  const { selection } = state;
  if (selection instanceof NodeSelection && selection.node.type.name === 'image') {
    const source = imageSource(selection.node);
    return { from: selection.from, to: selection.to, source, caret: source.length, image: true };
  }

  const ranges = activeMarkRanges(state);
  if (ranges.length === 0) return null;
  const from = Math.min(...ranges.map((range) => range.from));
  const to = Math.max(...ranges.map((range) => range.to));
  const tokens = ranges.flatMap((range) => {
    const markers = markMarkers(range);
    if (!markers) return [];
    const rank = markRank(range.mark.type.name);
    return [
      { pos: range.from, side: -100 + rank, text: markers[0] },
      { pos: range.to, side: 100 - rank, text: markers[1] },
    ];
  }).sort((a, b) => a.pos - b.pos || a.side - b.side);

  let source = '';
  let cursor = from;
  for (const token of tokens) {
    source += textBetween(state, cursor, token.pos) + token.text;
    cursor = token.pos;
  }
  source += textBetween(state, cursor, to);

  let caret = 0;
  cursor = from;
  for (const token of tokens) {
    if (token.pos > selection.from || (token.pos === selection.from && token.side >= 0)) break;
    caret += textBetween(state, cursor, token.pos).length + token.text.length;
    cursor = token.pos;
  }
  caret += textBetween(state, cursor, selection.from).length;

  return { from, to, source, caret, image: false };
}

function parsedInlineContent(
  source: string,
  state: EditorState,
  parseMarkdown: LocalSourcePluginOptions['parseMarkdown'],
): Fragment {
  try {
    const parsed = parseMarkdown(source);
    if (parsed && typeof parsed !== 'string' && parsed.childCount === 1) {
      const block = parsed.firstChild;
      if (block?.inlineContent) return block.content;
    }
  } catch {
    // Malformed Markdown remains editable as plain text instead of losing input.
  }
  return source ? Fragment.from(state.schema.text(source)) : Fragment.empty;
}

function editorDOM(view: EditorView, region: EditableSourceRegion, options: LocalSourcePluginOptions): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'mdw-local-source-editor-wrap' + (region.image ? ' image' : '');
  wrap.contentEditable = 'false';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'mdw-local-source-editor';
  input.value = region.source;
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Markdown 局部源码');
  wrap.appendChild(input);

  const resize = () => {
    input.style.width = `${Math.max(4, Math.min(80, input.value.length + 1))}ch`;
  };
  resize();
  input.addEventListener('input', resize);

  let finished = false;
  const close = (commit: boolean, focusEditor: boolean) => {
    if (finished) return;
    finished = true;
    const currentState = view.state as EditorState;
    let tr = currentState.tr;
    if (commit && input.value !== region.source) {
      const content = parsedInlineContent(input.value, currentState, options.parseMarkdown);
      tr = tr.replace(region.from, region.to, new Slice(content, 0, 0));
      const end = Math.min(region.from + content.size, tr.doc.content.size);
      tr = tr.setSelection(TextSelection.near(tr.doc.resolve(end), 1));
    }
    tr = tr.setMeta(localSourceRevealKey, 'suppress');
    view.dispatch(tr);
    if (focusEditor) queueMicrotask(() => view.focus());
  };

  input.addEventListener('blur', () => close(true, false));
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      close(true, true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(false, true);
    }
  });
  input.addEventListener('mousedown', (event) => event.stopPropagation());

  queueMicrotask(() => {
    if (!input.isConnected || finished) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(region.caret, region.caret);
  });
  return wrap;
}

/** Replace the active rendered mark/image with a temporary, editable Markdown source input. */
export function createLocalSourceRevealPlugin(options: LocalSourcePluginOptions): Plugin {
  return new Plugin({
    key: localSourceRevealKey,
    state: {
      init: (): LocalSourcePluginState => ({ suppressedSelection: null }),
      apply: (tr, value, oldState, newState): LocalSourcePluginState => {
        if (tr.getMeta(localSourceRevealKey) === 'suppress') {
          return { suppressedSelection: selectionKey(newState) };
        }
        if (tr.getMeta(localSourceRevealKey) === 'clear') {
          return { suppressedSelection: null };
        }
        if (!oldState.selection.eq(newState.selection)) return { suppressedSelection: null };
        return value;
      },
    },
    props: {
      handleDOMEvents: {
        mousedown(view) {
          const pluginState = localSourceRevealKey.getState(view.state);
          if (pluginState?.suppressedSelection === selectionKey(view.state)) {
            view.dispatch(view.state.tr.setMeta(localSourceRevealKey, 'clear'));
          }
          return false;
        },
      },
      decorations(state) {
        const pluginState = localSourceRevealKey.getState(state);
        if (pluginState?.suppressedSelection === selectionKey(state)) return DecorationSet.empty;
        const region = editableSourceRegion(state);
        if (!region) return DecorationSet.empty;
        const hidden = region.image
          ? Decoration.node(region.from, region.to, { class: 'mdw-local-source-hidden' })
          : Decoration.inline(region.from, region.to, { class: 'mdw-local-source-hidden' });
        const editor = Decoration.widget(
          region.from,
          (view) => editorDOM(view, region, options),
          {
            side: -1000,
            key: `editor:${region.from}:${region.to}:${region.source}`,
            ignoreSelection: true,
            stopEvent: () => true,
          },
        );
        return DecorationSet.create(state.doc, [hidden, editor]);
      },
    },
  });
}
