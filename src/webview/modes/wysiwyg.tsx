import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { Ctx, MilkdownPlugin } from '@milkdown/ctx';
import type { CmdKey } from '@milkdown/core';
import type { EditorView, NodeView } from '@milkdown/prose/view';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import {
  commandsCtx,
  Editor,
  defaultValueCtx,
  editorViewCtx,
  parserCtx,
  remarkStringifyOptionsCtx,
  rootCtx,
  serializerCtx,
} from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import {
  addColAfterCommand,
  addColBeforeCommand,
  addRowAfterCommand,
  addRowBeforeCommand,
  deleteSelectedCellsCommand,
  gfm,
  insertTableCommand,
  moveColCommand,
  moveRowCommand,
  selectColCommand,
  selectRowCommand,
  selectTableCommand,
  setAlignCommand,
  toggleStrikethroughCommand,
} from '@milkdown/kit/preset/gfm';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { cursor } from '@milkdown/kit/plugin/cursor';
import { history } from '@milkdown/kit/plugin/history';
import { indent } from '@milkdown/kit/plugin/indent';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import {
  createCodeBlockCommand,
  insertHrCommand,
  insertImageCommand,
  toggleEmphasisCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
  bulletListSchema,
  orderedListSchema,
} from '@milkdown/kit/preset/commonmark';
import { undo, redo } from '@milkdown/kit/prose/history';
import {
  forceUpdate,
  insert,
  replaceAll,
  $nodeSchema,
  $prose,
  $remark,
} from '@milkdown/kit/utils';
import hljs from 'highlight.js/lib/common';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { postMessage } from '../bridge';
import { bulletMarkerAt, consumeListStyleMarker, orderedLabel, preprocessExtendedLists } from '../listSyntax';
import { createLocalSourceRevealPlugin } from '../localSourceReveal';
import { tableGutterPlugin, tablePasteGuardPlugin, tableSelectAllPlugin } from '../tableGutter';

const bulletListStyleSchema = bulletListSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: { ...base.attrs, markerStyle: { default: '-', validate: 'string' } },
    toDOM: (node: any) => ['ul', { 'data-marker-style': node.attrs.markerStyle, 'data-spread': node.attrs.spread }, 0],
    parseMarkdown: {
      match: ({ type, ordered }: any) => type === 'list' && !ordered,
      runner: (state: any, node: any, type: any) => {
        state.openNode(type, { spread: node.spread ?? false, markerStyle: node.markerStyle ?? '-' })
          .next(node.children).closeNode();
      },
    },
    toMarkdown: {
      match: (node: any) => node.type.name === 'bullet_list',
      runner: (state: any, node: any) => {
        state.openNode('list', undefined, {
          ordered: false,
          spread: node.attrs.spread,
          markerStyle: node.attrs.markerStyle,
        }).next(node.content).closeNode();
      },
    },
  } as any;
});

const orderedListStyleSchema = orderedListSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: { ...base.attrs, markerStyle: { default: 'decimal', validate: 'string' } },
    toDOM: (node: any) => ['ol', {
      ...(node.attrs.order === 1 ? {} : { start: node.attrs.order }),
      'data-list-style': node.attrs.markerStyle,
      'data-spread': node.attrs.spread,
    }, 0],
    parseMarkdown: {
      match: ({ type, ordered }: any) => type === 'list' && !!ordered,
      runner: (state: any, node: any, type: any) => {
        state.openNode(type, {
          spread: node.spread ?? true,
          order: node.start ?? 1,
          markerStyle: node.markerStyle ?? 'decimal',
        }).next(node.children).closeNode();
      },
    },
    toMarkdown: {
      match: (node: any) => node.type.name === 'ordered_list',
      runner: (state: any, node: any) => {
        state.openNode('list', undefined, {
          ordered: true,
          start: node.attrs.order ?? 1,
          spread: node.attrs.spread,
          markerStyle: node.attrs.markerStyle,
        }).next(node.content).closeNode();
      },
    },
  } as any;
});

const listStyleRemark = $remark('mdwListStyle', () => () => (tree: any, file: any) => {
  const source = String(file?.value ?? '');
  const walk = (node: any) => {
    if (node.type === 'list') {
      if (node.ordered) {
        const first = node.children?.[0]?.children?.[0]?.children;
        const text = first?.[0];
        const metadata = text?.type === 'text' ? consumeListStyleMarker(text.value) : null;
        if (metadata) {
          node.markerStyle = metadata.style;
          if (metadata.text) text.value = metadata.text;
          else first.splice(0, 1);
        } else {
          node.markerStyle = 'decimal';
        }
      } else {
        const offset = node.position?.start?.offset;
        node.markerStyle = typeof offset === 'number' ? bulletMarkerAt(source, offset) : '-';
      }
    }
    node.children?.forEach(walk);
  };
  walk(tree);
});

function listMarkdownHandler(node: any, _parent: any, state: any, info: any): string {
  const exit = state.enter('list');
  const previous = state.bulletCurrent;
  state.bulletCurrent = node.ordered ? '.' : (['-', '+', '*'].includes(node.markerStyle) ? node.markerStyle : '-');
  const value = state.containerFlow(node, info);
  state.bulletLastUsed = state.bulletCurrent;
  state.bulletCurrent = previous;
  exit();
  return value;
}

function listItemMarkdownHandler(node: any, parent: any, state: any, info: any): string {
  let bullet = state.bulletCurrent || '-';
  if (parent?.ordered) {
    const index = parent.children.indexOf(node);
    const value = (typeof parent.start === 'number' ? parent.start : 1) + index;
    bullet = `${orderedLabel(value, parent.markerStyle ?? 'decimal')}.`;
  }
  const size = bullet.length + 1;
  const checkbox = typeof node.checked === 'boolean' ? `[${node.checked ? 'x' : ' '}] ` : '';
  const tracker = state.createTracker(info);
  tracker.move(bullet + ' ');
  tracker.shift(size);
  if (checkbox) tracker.move(checkbox);
  const exit = state.enter('listItem');
  const value = state.indentLines(
    state.containerFlow(node, tracker.current()),
    (line: string, index: number, blank: boolean) => index
      ? (blank ? '' : ' '.repeat(size)) + line
      : (blank ? bullet : bullet + ' ' + checkbox) + line
  );
  exit();
  return value;
}

/* ============ WYSIWYG 代码块语法高亮 ============ */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 代码块可选语言（与 highlight.js 支持对应）。 */
const CODE_LANGUAGES = [
  'plain', 'javascript', 'typescript', 'python', 'java', 'c', 'cpp', 'csharp',
  'go', 'rust', 'php', 'ruby', 'sql', 'json', 'html', 'css', 'bash', 'markdown',
  'yaml', 'xml', 'kotlin', 'swift', 'scala', 'lua', 'r', 'powershell', 'ini', 'diff',
];

/** 代码块 nodeView：下层可编辑纯文本（透明文字），上层高亮 HTML 覆盖层（pointer-events:none）。
 *  右上角为可点击的语言角标，点击弹出语言菜单（默认跟随 ```lang 输入规则自动带出语言）。 */
class CodeBlockHighlightView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private overlay: HTMLPreElement;
  private content: HTMLPreElement;
  private badge: HTMLDivElement;
  private menu: HTMLDivElement | null = null;
  private onScroll: () => void;
  private onDocDown: (e: MouseEvent) => void;
  private view: EditorView;
  private getPos: () => number | undefined;

  constructor(node: any, view: EditorView, getPos: () => number | undefined) {
    this.view = view;
    this.getPos = getPos;
    this.dom = document.createElement('div');
    this.dom.className = 'mdw-codeblock';

    this.overlay = document.createElement('pre');
    this.overlay.className = 'mdw-codeblock-overlay';
    this.overlay.setAttribute('aria-hidden', 'true');

    this.content = document.createElement('pre');
    this.content.className = 'mdw-codeblock-content';
    this.content.setAttribute('data-milkdown-codeblock', '');

    this.badge = document.createElement('div');
    this.badge.className = 'mdw-codeblock-lang';
    this.badge.title = '点击设置代码块语言';
    this.badge.addEventListener('mousedown', (e) => e.preventDefault());
    this.badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleMenu();
    });

    this.dom.appendChild(this.overlay);
    this.dom.appendChild(this.content);
    this.dom.appendChild(this.badge);
    this.contentDOM = this.content;

    this.onScroll = () => {
      this.overlay.scrollTop = this.content.scrollTop;
      this.overlay.scrollLeft = this.content.scrollLeft;
    };
    this.content.addEventListener('scroll', this.onScroll);

    this.onDocDown = (e) => {
      if (this.menu && !this.dom.contains(e.target as Node)) this.closeMenu();
    };
    this.render(node);
  }

  private toggleMenu(): void {
    if (this.menu) {
      this.closeMenu();
      return;
    }
    const menu = document.createElement('div');
    menu.className = 'mdw-codeblock-langmenu';
    const current = (this.badge.dataset.lang ?? '') || 'plain';
    CODE_LANGUAGES.forEach((lang) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mdw-codeblock-langitem' + (lang === current ? ' active' : '');
      b.textContent = lang;
      b.addEventListener('click', () => {
        const pos = this.getPos();
        if (pos != null) {
          this.view.dispatch(
            this.view.state.tr.setNodeAttribute(pos, 'language', lang === 'plain' ? '' : lang)
          );
        }
        this.closeMenu();
      });
      menu.appendChild(b);
    });
    this.dom.appendChild(menu);
    this.menu = menu;
    document.addEventListener('mousedown', this.onDocDown, true);
  }

  private closeMenu(): void {
    if (this.menu) {
      this.menu.remove();
      this.menu = null;
    }
    document.removeEventListener('mousedown', this.onDocDown, true);
  }

  private render(node: any): void {
    const lang: string = node.attrs.language || '';
    this.badge.textContent = lang || 'plain';
    this.badge.dataset.lang = lang;
    this.badge.style.display = 'flex';
    let html = '';
    if (lang && hljs.getLanguage(lang)) {
      try {
        html = hljs.highlight(node.textContent, { language: lang, ignoreIllegals: true }).value;
      } catch {
        html = escapeHtml(node.textContent);
      }
    } else {
      html = escapeHtml(node.textContent);
    }
    this.overlay.innerHTML = `<code class="hljs language-${escapeHtml(lang) || 'plaintext'}">${html}</code>`;
  }

  update(node: any): boolean {
    if (node.type.name !== 'code_block') return false;
    this.render(node);
    return true;
  }

  destroy(): void {
    this.closeMenu();
    this.content.removeEventListener('scroll', this.onScroll);
  }
}

/** 直接通过 ProseMirror 插件 props.nodeViews 注册代码块节点视图（不依赖异步注册，必然生效）。 */
const codeHighlightProse = $prose(() => {
  return new Plugin({
    key: new PluginKey('mdwCodeBlockHighlight'),
    props: {
      nodeViews: {
        code_block: (node, view, getPos) => new CodeBlockHighlightView(node, view, getPos),
      },
    },
  });
});

/** 光标进入行内格式或选中图片时，临时显示对应的 Markdown 源码标记。 */
const localSourceRevealProse = $prose((ctx) => createLocalSourceRevealPlugin({
  parseMarkdown: (markdown) => ctx.get(parserCtx)(markdown),
}));

/** WYSIWYG 链接以编辑为优先：普通点击不导航，Ctrl/Cmd+点击才打开外部链接。 */
const wysiwygLinkInteractionProse = $prose(() => {
  return new Plugin({
    key: new PluginKey('mdwWysiwygLinkInteraction'),
    props: {
      handleDOMEvents: {
        click: (view, event) => {
          const target = event.target as (Element & { closest?: Element['closest'] }) | null;
          const anchor = target?.closest?.('a[href]');
          if (!anchor || !view.dom.contains(anchor)) return false;

          const href = anchor.getAttribute('href')?.trim() ?? '';
          if ((event.ctrlKey || event.metaKey) && /^(https?:|mailto:)/i.test(href)) {
            event.preventDefault();
            postMessage({ type: 'open-external', href });
            return true;
          }

          // 普通点击、相对路径和不支持的协议都保持在编辑器内。
          event.preventDefault();
          return true;
        },
      },
    },
  });
});

/** 任务项复选框点击切换（GFM：li[data-item-type="task"] 左缘 14×14 复选框）。
 *  复选框是 CSS ::before 伪元素，点击目标就是 li 本身：命中复选框区域 →
 *  mousedown preventDefault（不让光标移进列表、不启动选区）+ click 切换 checked。 */
const taskCheckboxPlugin = $prose(() => {
  const checkboxLi = (event: MouseEvent): HTMLLIElement | null => {
    const t = event.target as Node | null;
    if (!t || t.nodeType !== 1) return null;
    const li = (t as HTMLElement).closest('li[data-item-type="task"]') as HTMLLIElement | null;
    if (!li) return null;
    const r = li.getBoundingClientRect();
    const em = parseFloat(getComputedStyle(li).fontSize) || 14;
    // 与 styles.css 一致：left = -1×--list-indent(1.8em) + 0.4em → li 左缘 -1.4em；top:0.35em；14×14（±5px 容差）
    const left = r.left - 1.4 * em;
    const top = r.top + 0.35 * em;
    const PAD = 5;
    return event.clientX >= left - PAD &&
      event.clientX <= left + 14 + PAD &&
      event.clientY >= top - PAD &&
      event.clientY <= top + 14 + PAD
      ? li
      : null;
  };
  return new Plugin({
    key: new PluginKey('mdwTaskCheckbox'),
    props: {
      handleDOMEvents: {
        mousedown: (view, event) => {
          if (checkboxLi(event)) {
            event.preventDefault();
            return true; // 跳过 ProseMirror 自身的 mousedown（不放置光标/不启动选区）
          }
          return false;
        },
        click: (view, event) => {
          const li = checkboxLi(event);
          if (!li) return false;
          const pos = view.posAtDOM(li, 0);
          if (pos >= 0) {
            const $pos = view.state.doc.resolve(pos);
            let itemPos = -1;
            for (let d = $pos.depth; d > 0; d--) {
              if ($pos.node(d).type.name === 'list_item') {
                itemPos = $pos.before(d);
                break;
              }
            }
            if (itemPos < 0 && $pos.nodeAfter?.type.name === 'list_item') itemPos = pos;
            if (itemPos >= 0) {
              const item = view.state.doc.nodeAt(itemPos);
              if (item) {
                const checked = item.attrs.checked === true;
                view.dispatch(
                  view.state.tr.setNodeMarkup(itemPos, undefined, { ...item.attrs, checked: !checked })
                );
              }
            }
          }
          event.preventDefault();
          return true;
        },
      },
    },
  });
});

/* ============ 图片宽度支持 ============ */

/** remark 解析插件：把图片后的 `{width=N}` 合并进 image.data.width。 */
const imageWidthRemark = $remark('mdwImageWidth', () => () => (tree: any) => {
  const walk = (node: any) => {
    if (node.children) {
      const children = node.children;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const next = children[i + 1];
        if (
          child.type === 'image' &&
          next &&
          next.type === 'text' &&
          typeof next.value === 'string'
        ) {
          const m = /^\{width=(\d+)\}$/.exec(next.value.trim());
          if (m) {
            child.data = { ...(child.data || {}), width: m[1] };
            children.splice(i + 1, 1);
            i--;
          }
        }
        walk(child);
      }
    }
  };
  walk(tree);
});

/** 覆盖 commonmark 的 image 节点：增加 width 属性（序列化为 `{width=N}`，Pandoc 风格）。 */
const imageWidthSchema = $nodeSchema('image', (): any => ({
  inline: true,
  group: 'inline',
  selectable: true,
  draggable: true,
  marks: '',
  atom: true,
  defining: true,
  isolating: true,
  attrs: {
    src: { default: '', validate: 'string' },
    alt: { default: '', validate: 'string' },
    title: { default: '', validate: 'string' },
    width: { default: null, validate: 'string|null' },
  },
  parseDOM: [
    {
      tag: 'img[src]',
      getAttrs: (dom: any) => {
        const el = dom as HTMLElement;
        const styleWidth = el.getAttribute('style')?.match(/width:\s*(\d+)px/);
        return {
          src: el.getAttribute('src') || '',
          alt: el.getAttribute('alt') || '',
          title: el.getAttribute('title') || el.getAttribute('alt') || '',
          width: styleWidth ? styleWidth[1] : null,
        };
      },
    },
  ],
  toDOM: (node: any) => {
    const attrs: Record<string, string> = {
      src: node.attrs.src,
      alt: node.attrs.alt,
    };
    if (node.attrs.title) attrs.title = node.attrs.title;
    if (node.attrs.width) attrs.style = `width: ${node.attrs.width}px`;
    return ['img', attrs];
  },
  parseMarkdown: {
    match: ({ type }: any) => type === 'image',
    runner: (state: any, node: any, type: any) => {
      state.addNode(type, {
        src: node.url,
        alt: node.alt,
        title: node.title ?? '',
        width: node.data?.width ? String(node.data.width) : null,
      });
    },
  },
  toMarkdown: {
    match: (node: any) => node.type.name === 'image',
    runner: (state: any, node: any) => {
      state.addNode('image', void 0, void 0, {
        title: node.attrs.title,
        url: node.attrs.src,
        alt: node.attrs.alt,
      });
      if (node.attrs.width) {
        state.addNode('text', void 0, `{width=${node.attrs.width}}`);
      }
    },
  },
}));

/* ============ 命令与状态 API ============ */

/** App 通过该 API 调工具栏命令。 */
export interface WysiwygApi {
  bold(): void;
  italic(): void;
  strike(): void;
  heading(level: number): void;
  paragraph(): void;
  bulletList(): void;
  orderedList(): void;
  taskList(): void;
  quote(): void;
  codeBlock(): void;
  table(rows: number, cols: number): void;
  link(href: string): void;
  insertImage(src: string, alt: string): void;
  hr(): void;
  undo(): void;
  redo(): void;
  insertText(text: string): void;
  /* 表格编辑（光标在表格内时） */
  selectRow(): void;
  selectCol(): void;
  selectTable(): void;
  addRow(dir: -1 | 1): void;
  deleteRow(): void;
  moveRow(dir: -1 | 1): void;
  addCol(dir: -1 | 1): void;
  deleteCol(): void;
  moveCol(dir: -1 | 1): void;
  alignCell(align: 'left' | 'center' | 'right'): void;
  /** 大纲跳转：定位并滚动到指定标题。 */
  jumpToHeading(level: number, text: string): void;
  /** 获取当前文档的 markdown（供"保存"按钮取实时内容，无序列化防抖延迟）。 */
  getMarkdown(): string;
  /** 从 display:none 切回后让编辑器重新测量布局。 */
  refresh(): void;
}

/** 光标/选区处的格式状态，用于工具栏高亮（Jira 式）。 */
export interface EditorStateInfo {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  heading: number | null;
  bullet: boolean;
  ordered: boolean;
  task: boolean;
  quote: boolean;
  codeBlock: boolean;
  inTable: boolean;
}

interface Props {
  content: string;
  onChange(md: string): void;
  apiRef: MutableRefObject<WysiwygApi | null>;
  onStateChange?(info: EditorStateInfo): void;
}

function computeEditorState(ctx: Ctx): EditorStateInfo {
  const view = ctx.get(editorViewCtx);
  const { state } = view;
  const { selection, schema } = state;
  const $from = selection.$from;
  const marks = schema.marks as unknown as Record<string, { name: string }>;
  // 空选区应用格式时格式记录在 storedMarks 中
  const cursorMarks = state.storedMarks ?? $from.marks();
  const hasMark = (name: string) => {
    const type = marks[name];
    if (!type) return false;
    const { from, to } = selection;
    let found = false;
    state.doc.nodesBetween(Math.min(from, to), Math.max(from, to), (node) => {
      if (node.marks.some((m) => m.type.name === name)) found = true;
      return !found;
    });
    return found || cursorMarks.some((m) => m.type.name === name);
  };

  const info: EditorStateInfo = {
    bold: hasMark('strong'),
    italic: hasMark('emphasis'),
    strike: hasMark('strike_through'),
    heading: null,
    bullet: false,
    ordered: false,
    task: false,
    quote: false,
    codeBlock: false,
    inTable: false,
  };

  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    switch (node.type.name) {
      case 'heading':
        info.heading = node.attrs.level as number;
        break;
      case 'list_item':
        // gfm 任务项：checked 非 null 即为任务项
        // （先于上层 bullet_list/ordered_list 命中，决定列表 icon 是否让位给任务 icon）
        info.task = (node.attrs as { checked?: boolean | null }).checked != null;
        break;
      case 'bullet_list':
        // 任务列表在 schema 上就是 bullet_list + checked 项：只亮"任务列表"图标，不与"无序列表"同时亮
        if (!info.task) info.bullet = true;
        break;
      case 'ordered_list':
        if (!info.task) info.ordered = true;
        break;
      case 'blockquote':
        info.quote = true;
        break;
      case 'table':
        info.inTable = true;
        break;
    }
  }
  info.codeBlock = $from.parent.type.name === 'code_block';
  return info;
}

function statesEqual(a: EditorStateInfo, b: EditorStateInfo): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.strike === b.strike &&
    a.heading === b.heading &&
    a.bullet === b.bullet &&
    a.ordered === b.ordered &&
    a.task === b.task &&
    a.quote === b.quote &&
    a.codeBlock === b.codeBlock &&
    a.inTable === b.inTable
  );
}

function useSafeRun(editor: Editor | undefined) {
  return (fn: () => unknown) => {
    if (!editor) return;
    try {
      fn();
    } catch (err) {
      console.error('[wysiwyg] command failed', err);
    }
  };
}

/** 光标/选区所在表格的行列信息。 */
function getTableInfo(ctx: Ctx): { tablePos: number; row: number; col: number } | null {
  const view = ctx.get(editorViewCtx);
  const selection = view.state.selection as any;
  const $from = selection.$anchorCell ?? selection.$from;
  let tablePos = -1;
  let row = -1;
  let col = -1;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'table') {
      tablePos = $from.before(d);
      break;
    }
    if (n.type.name === 'table_cell' || n.type.name === 'table_header') col = $from.index(d);
    if (n.type.name === 'table_row') row = $from.index(d);
  }
  if (tablePos < 0 || row < 0 || col < 0) return null;
  return { tablePos, row, col };
}

/** 列表互斥转换：在列表内点其他列表类型 → 整个列表转换为目标类型（不建子列表）。
 *  关键：转换时必须同步更新列表项的 listType/label 属性——milkdown 的 keep-list-order
 *  插件（appendTransaction）发现"bullet_list 里的项 listType=ordered"就会把列表改回有序，
 *  导致 有序→无序 / 有序→任务 转换后立即被回退。任务项按 GFM 只存在于无序列表（"- [ ]"）。 */
function toggleListType(
  ctx: Ctx,
  target: 'bullet' | 'ordered' | 'task',
  insertMarkdown: (md: string) => void
): void {
  const view = ctx.get(editorViewCtx);
  const { state, dispatch } = view;
  const { $from } = state.selection;
  const schema = state.schema;

  let listPos = -1;
  let listNode: any = null;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'bullet_list' || n.type.name === 'ordered_list') {
      listPos = $from.before(d);
      listNode = n;
      break;
    }
  }

  if (!listNode) {
    // 不在列表中：新建对应列表
    if (target === 'bullet') {
      ctx.get(commandsCtx).call(wrapInBulletListCommand.key);
    } else if (target === 'ordered') {
      ctx.get(commandsCtx).call(wrapInOrderedListCommand.key);
    } else {
      // task：把当前块替换为任务列表（确定性，不依赖 markdown 解析）
      const block = $from.parent;
      const itemType = schema.nodes.list_item;
      const bulletType = schema.nodes.bullet_list;
      if (itemType && bulletType && (block.type.name === 'paragraph' || block.type.name === 'heading')) {
        try {
          // gfm 任务项：checked 非 null（false=未勾选）
          const item = itemType.create({ checked: false }, block);
          const list = bulletType.create(null, item);
          const start = $from.before($from.depth);
          let tr = state.tr.replaceWith(start, start + block.nodeSize, list);
          tr = tr.setSelection(TextSelection.near(tr.doc.resolve(start + 1)));
          dispatch(tr);
          return;
        } catch (err) {
          console.error('[wysiwyg] task list create failed', err);
        }
      }
      insertMarkdown('- [ ] ');
    }
    return;
  }

  const toTask = target === 'task';
  // GFM 任务项只能在无序列表里：有序→任务时列表节点本身也要转成无序
  const targetTypeName = target === 'ordered' ? 'ordered_list' : 'bullet_list';
  const targetType = schema.nodes[targetTypeName] as any;
  const toOrdered = targetTypeName === 'ordered_list';
  const listTypeChanged = listNode.type.name !== targetTypeName;

  // 已无实际转换需求才跳过：
  // - 任务目标：所有项都已是任务项
  // - 普通列表目标（bullet/ordered）：列表类型一致，且列表里没有任何任务项需要还原
  //   （任务列表 = bullet_list + checked，点"无序列表"= 把 checked 全部还原为 null）
  if (!listTypeChanged) {
    if (toTask) {
      let allTask = true;
      listNode.descendants((child: any) => {
        if (child.type.name === 'list_item' && child.attrs.checked == null) allTask = false;
        return allTask;
      });
      if (allTask) return;
    } else {
      let hasTask = false;
      listNode.descendants((child: any) => {
        if (child.type.name === 'list_item' && child.attrs.checked != null) {
          hasTask = true;
          return false;
        }
        return !hasTask;
      });
      if (!hasTask) return;
    }
  }

  let tr = state.tr;
  // 1) 列表节点类型（有序↔无序，或有序→任务时先转无序）
  if (listTypeChanged) {
    tr = tr.setNodeMarkup(listPos, targetType, listNode.attrs);
  }
  // 2) 列表项：统一 listType/label（否则 keep-list-order 插件会回退转换），
  //    并更新 checked（普通项→任务项 = false；任务项→普通项 = null）
  const order = listNode.attrs.order ?? 1;
  listNode.descendants((child: any, offset: number, _parent: any, index: number) => {
    if (child.type.name !== 'list_item') return true;
    const attrs = { ...child.attrs };
    let changed = false;
    const wantListType = toOrdered ? 'ordered' : 'bullet';
    if (attrs.listType !== wantListType) {
      attrs.listType = wantListType;
      changed = true;
    }
    const wantLabel = toOrdered ? `${order + index}.` : '•';
    if (attrs.label !== wantLabel) {
      attrs.label = wantLabel;
      changed = true;
    }
    const isTask = attrs.checked != null;
    if (isTask !== toTask) {
      attrs.checked = toTask ? (isTask ? attrs.checked : false) : null;
      changed = true;
    }
    if (changed) {
      tr = tr.setNodeMarkup(listPos + 1 + offset, undefined, attrs);
    }
    return true;
  });
  dispatch(tr);
}

function MilkdownEditor({ content, onChange, apiRef, onStateChange }: Props) {
  const lastRef = useRef<string>(content);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const apiRefRef = useRef(apiRef);
  apiRefRef.current = apiRef;
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const lastStateRef = useRef<EditorStateInfo | null>(null);
  /** 最新 content prop（供 markdownUpdated 在外部同步时把基线重置为输入内容）。 */
  const contentRef = useRef(content);
  contentRef.current = content;
  /**
   * 外部内容同步（打开/磁盘变更/模式切换）触发整文档替换后，其归一化序列化结果
   * 不应写回文件。记录"替换后的序列化结果"，markdownUpdated 只有精确等于它时才抑制；
   * 用户随即的首次键入（结果不同）不会被误吞。
  */
  const suppressSerializedRef = useRef<string | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);

  /** 计算并推送光标格式状态（含去重）。供监听器与命令执行后调用。 */
  const emitState = (ctx: Ctx) => {
    if (!onStateChangeRef.current) return;
    const info = computeEditorState(ctx);
    if (lastStateRef.current && statesEqual(lastStateRef.current, info)) return;
    lastStateRef.current = info;
    onStateChangeRef.current(info);
  };

  /** 图片选中时显示右下角缩放手柄；拖拽更新 width 属性（序列化为 {width=N}）。 */
  const syncResizeHandle = (view: EditorView) => {
    const sel = view.state.selection;
    const isImage = sel instanceof NodeSelection && sel.node.type.name === 'image';
    const dom = isImage ? (view.nodeDOM(sel.from) as HTMLElement | null) : null;
    if (!isImage || !dom || !(dom instanceof HTMLImageElement)) {
      if (handleRef.current) handleRef.current.style.display = 'none';
      return;
    }
    let handle = handleRef.current;
    const host = view.dom.parentElement ?? document.body;
    if (!handle) {
      handle = document.createElement('div');
      handle.className = 'mdw-resize-handle';
      handle.title = '拖拽调整图片大小';
      host.appendChild(handle);
      handleRef.current = handle;
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = (view.nodeDOM(sel.from) as HTMLElement).getBoundingClientRect().width;
        const move = (ev: MouseEvent) => {
          const w = Math.max(40, Math.round(startW + (ev.clientX - startX)));
          const s = view.state.selection;
          if (s instanceof NodeSelection && s.node.type.name === 'image') {
            view.dispatch(
              view.state.tr.setNodeMarkup(s.from, undefined, {
                ...s.node.attrs,
                width: String(w),
              })
            );
          }
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
    }
    const rect = dom.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    handle.style.display = 'block';
    handle.style.left = `${rect.right - hostRect.left - 8}px`;
    handle.style.top = `${rect.bottom - hostRect.top - 8}px`;
  };

  const { get, loading } = useEditor(
    (container) => {
      const plugins: MilkdownPlugin[] = [
        // 表格粘贴守卫 + Ctrl+A 选中整表：必须排在 gfm（tableEditing/baseKeymap）之前，
        // 否则混合切片会被 tableEditing 包进格子、Ctrl+A 会选中整篇文档。
        tableSelectAllPlugin as unknown as MilkdownPlugin,
        tablePasteGuardPlugin as unknown as MilkdownPlugin,
        ...commonmark,
        // 保留 tableEditing：CellSelection 需要它做原生渲染（否则会被渲染成文本选区）。
        // 鼠标跨单元格拖选区域由 tableGutter 的捕获层拦截。
        ...gfm,
        bulletListStyleSchema as unknown as MilkdownPlugin,
        orderedListStyleSchema as unknown as MilkdownPlugin,
        listStyleRemark as unknown as MilkdownPlugin,
        imageWidthSchema as unknown as MilkdownPlugin,
        imageWidthRemark as unknown as MilkdownPlugin,
        codeHighlightProse as unknown as MilkdownPlugin,
        localSourceRevealProse as unknown as MilkdownPlugin,
        wysiwygLinkInteractionProse as unknown as MilkdownPlugin,
        taskCheckboxPlugin as unknown as MilkdownPlugin,
        tableGutterPlugin as unknown as MilkdownPlugin,
        ...history,
        clipboard,
        listener,
        ...cursor,
        ...indent,
      ];
      const editor = Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, container);
          ctx.set(defaultValueCtx, preprocessExtendedLists(content));
          // 序列化风格与常见手写 markdown 一致，避免"打开即被重写/编辑一次整篇重排"：
          // - 保留已导入列表的 `-` / `+` / `*` 标记，新列表默认用 `-`；
          // - 表格用紧凑格式 `| a | b |`（单空格、不按列补宽对齐）；
          // - 纯文本不转义下划线（`add_charts` 保持原样，而不是 `add\_charts`）。
          // 注：remarkStringifyOptionsCtx 的类型只声明了 handlers/encode，扩展选项需断言。
          ctx.update(remarkStringifyOptionsCtx, (prev) => {
            const base = prev as { handlers?: Record<string, unknown> };
            return {
              ...base,
              bullet: '-',
              handlers: {
                ...(base.handlers ?? {}),
                list: listMarkdownHandler,
                listItem: listItemMarkdownHandler,
                text: (node: { value: string }, _p: unknown, state: any, info: any) => {
                  const value = node.value;
                  if (/^[^*_\\]*\s+$/.test(value)) return value;
                  // 仅去掉 phrasing 中的 `_` 转义（保留行首 atBreak 的转义），
                  // 让 `add_charts` 这类词内下划线原样输出。
                  const saved = state.unsafe;
                  state.unsafe = saved.filter((u: { character?: string; atBreak?: boolean }) =>
                    u.character === '_' ? !!u.atBreak : true
                  );
                  try {
                    return state.safe(value, { ...info, encode: [] });
                  } finally {
                    state.unsafe = saved;
                  }
                },
                table: (node: any, _p: unknown, state: any, info: any) => {
                  // 紧凑表格：每行 `| a | b |`，表头下 `| --- | --- |`，不做列对齐
                  const rows = node.children.map((row: any) =>
                    row.children.map((cell: any) =>
                      state.containerPhrasing(cell, { ...info, before: ' ', after: ' ' })
                    )
                  );
                  const header = rows[0] ?? [];
                  const delimiter = header.map(() => '---');
                  return [header, delimiter, ...rows.slice(1)]
                    .map((row: string[]) => '| ' + row.join(' | ') + ' |')
                    .join('\n');
                },
              },
            } as any;
          });
          ctx.get(listenerCtx)
            .markdownUpdated((_, md) => {
              // 打开/磁盘变更/模式同步引发的整文档替换（replaceAll）也会触发这里：
              // 其归一化序列化结果不应写回文件——只有与 replaceAll 后的序列化结果
              // 完全一致时才抑制；用户编辑（结果不同）正常保存。
              if (suppressSerializedRef.current !== null) {
                if (md === suppressSerializedRef.current) {
                  suppressSerializedRef.current = null;
                  lastRef.current = contentRef.current;
                  return;
                }
                // 已出现用户编辑：撤销抑制，正常保存
                suppressSerializedRef.current = null;
              }
              if (md === lastRef.current) return;
              lastRef.current = md;
              onChangeRef.current(md);
            })
            .selectionUpdated((ctx) => {
              // 注意：listener 的 selectionUpdated 在 ProseMirror state.apply 期间同步触发，
              // 此刻 view.state 仍是旧状态——直接 emitState 会算出旧格式状态并被 statesEqual
              // 去重，工具栏将不随点击移动光标而高亮（表现为"要点两下/打字后才高亮"）。
              // 推迟到微任务：等事务应用完成、view.state 更新为最新后再计算。
              queueMicrotask(() => {
                emitState(ctx);
                syncResizeHandle(ctx.get(editorViewCtx));
              });
            })
            .updated((ctx) => {
              emitState(ctx);
              syncResizeHandle(ctx.get(editorViewCtx));
            })
            .focus((ctx) => emitState(ctx));
        })
        .use(plugins);
      return editor;
    },
    [] // 只创建一次
  );

  // 把工具栏命令暴露给 App（通过当前 editor 自己的 ctx 执行，避免多面板串号）
  useEffect(() => {
    if (loading) return;
    const editor = get();
    if (!editor) return;
    const safe = useSafeRun(editor);
    /** 执行命令后立即重算并推送光标格式状态（保证图标高亮实时、无需二次点击）。 */
    const withCtx = (fn: (ctx: Ctx) => void) =>
      safe(() => {
        editor.action((ctx) => {
          fn(ctx);
          emitState(ctx);
          return true;
        });
      });
    const runCmd = (cmd: { key: CmdKey<any> }, payload?: any) =>
      withCtx((ctx) => {
        ctx.get(commandsCtx).call(cmd.key, payload);
      });
    const withView = (fn: (view: EditorView) => void) =>
      withCtx((ctx) => {
        fn(ctx.get(editorViewCtx));
      });
    /** 以 markdown 解析方式插入文本（用于任务项等需要解析的场景）。 */
    const insertMd = (md: string) =>
      safe(() => {
        editor.action((ctx) => {
          void insert(md)(ctx);
          emitState(ctx);
          return true;
        });
      });
    /** 先选中当前行/列，再执行操作（保证表格命令作用在正确位置）。 */
    const tableOp =
      (
        select: 'row' | 'col',
        op: (cmds: { call(slice: any, payload?: any): boolean }, info: { row: number; col: number }) => void
      ) =>
      withCtx((ctx) => {
        const info = getTableInfo(ctx);
        if (!info) return;
        const cmds = ctx.get(commandsCtx);
        if (select === 'row') cmds.call(selectRowCommand.key, { index: info.row, pos: info.tablePos + 1 });
        else cmds.call(selectColCommand.key, { index: info.col, pos: info.tablePos + 1 });
        op(cmds, info);
      });

    apiRefRef.current.current = {
      bold: () => runCmd(toggleStrongCommand),
      italic: () => runCmd(toggleEmphasisCommand),
      strike: () => runCmd(toggleStrikethroughCommand),
      heading: (level) => runCmd(wrapInHeadingCommand, level),
      paragraph: () => runCmd(turnIntoTextCommand),
      bulletList: () => withCtx((ctx) => toggleListType(ctx, 'bullet', insertMd)),
      orderedList: () => withCtx((ctx) => toggleListType(ctx, 'ordered', insertMd)),
      taskList: () => withCtx((ctx) => toggleListType(ctx, 'task', insertMd)),
      quote: () => runCmd(wrapInBlockquoteCommand),
      codeBlock: () => runCmd(createCodeBlockCommand),
      table: (rows, cols) => runCmd(insertTableCommand, { row: rows, col: cols }),
      link: (href) => runCmd(toggleLinkCommand, { href }),
      insertImage: (src, alt) => runCmd(insertImageCommand, { src, alt }),
      hr: () => runCmd(insertHrCommand),
      undo: () => withView((view) => undo(view.state, view.dispatch)),
      redo: () => withView((view) => redo(view.state, view.dispatch)),
      insertText: (text) => safe(() => editor.action(insert(text))),
      /* 表格编辑 */
      selectRow: () =>
        withCtx((ctx) => {
          const info = getTableInfo(ctx);
          if (info) ctx.get(commandsCtx).call(selectRowCommand.key, { index: info.row, pos: info.tablePos + 1 });
        }),
      selectCol: () =>
        withCtx((ctx) => {
          const info = getTableInfo(ctx);
          if (info) ctx.get(commandsCtx).call(selectColCommand.key, { index: info.col, pos: info.tablePos + 1 });
        }),
      selectTable: () => runCmd(selectTableCommand),
      addRow: (dir) =>
        tableOp('row', (cmds) => {
          cmds.call(dir < 0 ? addRowBeforeCommand.key : addRowAfterCommand.key);
        }),
      deleteRow: () =>
        tableOp('row', (cmds) => {
          cmds.call(deleteSelectedCellsCommand.key);
        }),
      moveRow: (dir) =>
        tableOp('row', (cmds, info) => {
          cmds.call(moveRowCommand.key, { from: info.row, to: info.row + dir });
        }),
      addCol: (dir) =>
        tableOp('col', (cmds) => {
          cmds.call(dir < 0 ? addColBeforeCommand.key : addColAfterCommand.key);
        }),
      deleteCol: () =>
        tableOp('col', (cmds) => {
          cmds.call(deleteSelectedCellsCommand.key);
        }),
      moveCol: (dir) =>
        tableOp('col', (cmds, info) => {
          cmds.call(moveColCommand.key, { from: info.col, to: info.col + dir });
        }),
      alignCell: (align) =>
        withCtx((ctx) => {
          const selection = ctx.get(editorViewCtx).state.selection as any;
          const isCellSel = !!selection.$anchorCell;
          if (!isCellSel) {
            const info = getTableInfo(ctx);
            if (info) ctx.get(commandsCtx).call(selectRowCommand.key, { index: info.row, pos: info.tablePos + 1 });
          }
          ctx.get(commandsCtx).call(setAlignCommand.key, align);
        }),
      jumpToHeading: (level, text) =>
        withView((view) => {
          let foundPos = -1;
          view.state.doc.descendants((node, pos) => {
            if (
              node.type.name === 'heading' &&
              node.attrs.level === level &&
              node.textContent.trim() === text.trim()
            ) {
              foundPos = pos;
              return false;
            }
            return true;
          });
          if (foundPos >= 0) {
            const resolved = view.state.doc.resolve(foundPos + 1);
            view.dispatch(view.state.tr.setSelection(TextSelection.near(resolved)));
            view.focus();
            // 滚动到可视区域最顶部（标题紧贴内容区上沿）
            try {
              const headingDom = view.nodeDOM(foundPos) as HTMLElement | null;
              const pane = view.dom.closest('.mode-pane') as HTMLElement | null;
              if (headingDom && pane) {
                const top =
                  headingDom.getBoundingClientRect().top -
                  pane.getBoundingClientRect().top +
                  pane.scrollTop;
                pane.scrollTop = Math.max(0, top - 4);
              }
            } catch {
              /* 忽略滚动异常 */
            }
          }
        }),
      refresh: () =>
        safe(() => {
          editor.action(forceUpdate());
          return true;
        }),
      getMarkdown: () => {
        let md = '';
        safe(() => {
          editor.action((ctx) => {
            md = ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc);
            return true;
          });
        });
        return md;
      },
    };
    // 编辑器就绪后立即推送一次光标格式状态（进入列表/加载后图标即时高亮）
    safe(() => {
      editor.action((ctx) => {
        emitState(ctx);
        return true;
      });
    });
    return () => {
      apiRefRef.current.current = null;
      if (handleRef.current) {
        handleRef.current.remove();
        handleRef.current = null;
      }
    };
  }, [loading, get]);

  // 外部内容变化（来自源码/预览/磁盘）→ 全量替换
  useEffect(() => {
    if (loading) return;
    if (content === lastRef.current) return;
    const editor = get();
    if (!editor) return;
    try {
      // 整文档替换属于外部同步，其归一化序列化结果不写回文件。
      editor.action((ctx) => {
        replaceAll(preprocessExtendedLists(content))(ctx);
        const view = ctx.get(editorViewCtx);
        suppressSerializedRef.current = ctx.get(serializerCtx)(view.state.doc);
        return true;
      });
      lastRef.current = content;
    } catch (err) {
      console.error('[wysiwyg] replaceAll failed', err);
    }
  }, [content, loading, get]);

  return <Milkdown />;
}

export default function WysiwygMode(props: Props) {
  return (
    <MilkdownProvider>
      <MilkdownEditor {...props} />
    </MilkdownProvider>
  );
}
