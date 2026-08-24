/**
 * Obsidian 风格表格交互：
 * - 鼠标靠近行/列边界线 → 线的开头（左缘/上缘）直接显示 + 加号与插入线（无圆点中间态）；
 * - 点击 + 在对应边界插入一行/列；
 * - 同时命中行边界与列边界（单元格角）→ 两个 + 同时显示；
 * - 鼠标放到行头（左侧条）/列头（上侧条）中间 → 直接显示 6 点手柄，点击选中整行/列并弹出设置菜单。
 * 定位方案：覆盖层 absolute 挂载在编辑器宿主内，元素坐标 = 宿主内相对坐标；
 * 行/列信息按单元格（td/th）矩形聚合，插入线宽/高 = 单元格实际范围。
 */
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { keymap } from '@milkdown/prose/keymap';
import { $prose } from '@milkdown/kit/utils';
import {
  addColumn,
  addColumnAfter,
  addColumnBefore,
  addRow,
  addRowAfter,
  addRowBefore,
  CellSelection,
  deleteColumn,
  deleteRow,
  findTable,
  moveTableColumn,
  moveTableRow,
  setCellAttr,
  TableMap,
} from '@milkdown/kit/prose/tables';
import { selectCol, selectRow } from '@milkdown/kit/preset/gfm';

/** 设置菜单项图标（内联 SVG，跟随文字颜色）。 */
const icon = (paths: string): string =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const MENU_ICONS: Record<string, string> = {
  // 表格外框式：2×2 网格 + 加粗高亮线标出新行/新列位置
  insertAbove: icon(
    '<rect x="6" y="10" width="12" height="10" rx="1.5"/><path d="M6 15h12"/><path d="M6 6h12" stroke-width="3.5" stroke-linecap="round"/>'
  ),
  insertBelow: icon(
    '<rect x="6" y="4" width="12" height="10" rx="1.5"/><path d="M6 9h12"/><path d="M6 18h12" stroke-width="3.5" stroke-linecap="round"/>'
  ),
  insertLeft: icon(
    '<rect x="10" y="4" width="10" height="12" rx="1.5"/><path d="M15 4v12"/><path d="M6 4v12" stroke-width="3.5" stroke-linecap="round"/>'
  ),
  insertRight: icon(
    '<rect x="4" y="4" width="10" height="12" rx="1.5"/><path d="M9 4v12"/><path d="M18 4v12" stroke-width="3.5" stroke-linecap="round"/>'
  ),
  delete: icon('<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  moveUp: icon('<path d="M12 19V5M5 12l7-7 7 7"/>'),
  moveDown: icon('<path d="M12 5v14M19 12l-7 7-7-7"/>'),
  moveLeft: icon('<path d="M19 12H5M12 19l-7-7 7-7"/>'),
  moveRight: icon('<path d="M5 12h14M12 5l7 7-7 7"/>'),
  alignLeft: icon('<path d="M4 6h16M4 12h10M4 18h13"/>'),
  alignCenter: icon('<path d="M3 6h18M6 12h12M3 18h18"/>'),
  alignRight: icon('<path d="M4 6h16M10 12h10M7 18h13"/>'),
};

export interface TableRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

export interface RowRect {
  top: number;
  center: number;
  bottom: number;
}

export interface ColRect {
  left: number;
  center: number;
  right: number;
}

export type GutHit =
  | { type: 'row-boundary'; index: number }
  | { type: 'col-boundary'; index: number }
  | { type: 'row-handle'; index: number }
  | { type: 'col-handle'; index: number }
  | { type: null };

/**
 * 命中检测（纯函数，可单测）：
 * - 行边界 i（i≥1，表头前不插行）：仅在左侧行头条内、且鼠标距第 i 行上边界 ≤ tol（T 型交叉）；
 * - 列边界 j：仅在顶部列头条内、且鼠标距第 j 列左边界 ≤ tol（T 型交叉）；列优先于行；
 * - 行手柄：鼠标在左侧窄条内且落在某行的整段高度范围；
 * - 列手柄：鼠标在上侧窄条内且落在某列的整段宽度范围。
 * 表格中间的行列线不触发任何显示。
 */
export function hitTest(
  mx: number,
  my: number,
  rect: TableRect,
  rows: RowRect[],
  cols: ColRect[],
  tol = 6,
  strip = 14
): GutHit {
  // 列边界（顶部列头条内的 T 型交叉处；j=0 也在此触发）
  let colBoundary = -1;
  if (my >= rect.top - strip && my <= rect.top + 10) {
    for (let j = 0; j <= cols.length; j++) {
      const x = j === cols.length ? cols[cols.length - 1].right : cols[j].left;
      if (Math.abs(mx - x) <= tol) {
        colBoundary = j;
        break;
      }
    }
  }
  // 行边界（左侧行头条内的 T 型交叉处；i=1..N）
  let rowBoundary = -1;
  if (mx >= rect.left - strip && mx <= rect.left + 12) {
    for (let i = 1; i <= rows.length; i++) {
      const y = i === rows.length ? rows[rows.length - 1].bottom : rows[i].top;
      if (Math.abs(my - y) <= tol) {
        rowBoundary = i;
        break;
      }
    }
  }

  // 列优先（左上角等重叠区域 = 插列）
  if (colBoundary >= 0) return { type: 'col-boundary', index: colBoundary };
  if (rowBoundary >= 0) return { type: 'row-boundary', index: rowBoundary };

  // 行手柄（左侧窄条，命中该行整段高度）
  if (mx >= rect.left - strip && mx <= rect.left + 12) {
    for (let i = 0; i < rows.length; i++) {
      if (my >= rows[i].top && my <= rows[i].bottom) return { type: 'row-handle', index: i };
    }
  }
  // 列手柄（上侧窄条，命中该列整段宽度）
  if (my >= rect.top - strip && my <= rect.top + 10) {
    for (let j = 0; j < cols.length; j++) {
      if (mx >= cols[j].left && mx <= cols[j].right) return { type: 'col-handle', index: j };
    }
  }

  return { type: null };
}

/** 事件目标 → 元素（文本节点取父元素，避免 closest 在文本节点上抛错）。 */
export function eventTargetEl(target: EventTarget | null): HTMLElement | null {
  if (!target) return null;
  const n = target as Node;
  return n.nodeType === 1 ? (n as HTMLElement) : ((n.parentElement ?? null) as HTMLElement | null);
}

/**
 * 拖拽起点是否应被禁止：
 * - 当前是整行/整列选中（CellSelection）→ 禁止（选中行/列后拖动必须无反应，禁止新建表格）；
 * - 起点在表格单元格（td/th）内 → 禁止（单元格文字拖动无反应，禁止拖出/拖乱结构）。
 */
export function shouldBlockDragStart(sel: any, targetEl: HTMLElement | null): boolean {
  return !!(sel && sel.$anchorCell != null) || !!targetEl?.closest('td,th');
}

/**
 * 拖放是否应被禁止：
 * - 拖放内容含表格结构（<table/<tr/<td/<th）→ 禁止（防止在表格下方新建表格等未知结构）；
 * - 落点在表格单元格内 → 禁止（内容不能拖进表格）。
 */
export function shouldBlockDrop(html: string, targetEl: HTMLElement | null): boolean {
  if (/<table|<tr|<td|<th/i.test(html)) return true;
  return !!targetEl?.closest('td,th');
}

/** 拖放切片是否包含表格节点（ProseMirror 层兜底）。 */
function sliceHasTable(slice: any): boolean {
  if (!slice || !slice.content) return false;
  let found = false;
  const check = (frag: any): void => {
    if (found) return;
    frag.forEach((node: any) => {
      if (found) return;
      const name = node.type?.name ?? '';
      if (name === 'table' || name === 'table_row' || name === 'table_cell' || name === 'table_header') {
        found = true;
        return;
      }
      if (node.content) check(node.content);
    });
  };
  check(slice.content);
  return found;
}

interface TableCtx {
  el: HTMLTableElement;
  rect: TableRect;
  /** 单元格内容实际范围（用于插入线，避免 display:block 拉伸的 table 元素虚宽）。 */
  contentLeft: number;
  contentRight: number;
  hostRect: DOMRect;
  rows: RowRect[];
  cols: ColRect[];
  /** 表格节点在文档中的起始位置。 */
  pos: number;
}

class TableGutterView {
  private view: EditorView;
  private overlay: HTMLDivElement;
  private rowPlus: HTMLDivElement;
  private colPlus: HTMLDivElement;
  private rowLine: HTMLDivElement;
  private colLine: HTMLDivElement;
  private rowHandle: HTMLDivElement;
  private colHandle: HTMLDivElement;
  private menu: HTMLDivElement;
  private menuKind: 'row' | 'col' | null = null;
  private menuIndex = -1;
  /** 菜单打开时：鼠标移动不隐藏手柄/菜单，仅点击外部关闭。 */
  private menuOpen = false;
  /** 拖动手柄移动行/列时的状态（null = 未拖动）。 */
  private dragState: { kind: 'row' | 'col'; index: number; dragging: boolean } | null = null;
  private suppressNextClick = false;
  private ctx: TableCtx | null = null;
  /** ctx 缓存：同一表格元素 + 未滚动/未缩放/无编辑事务时复用，
   *  避免每帧 mousemove 都做全表 getBoundingClientRect + posAtDOM（布局抖动）。 */
  private ctxCache: { el: HTMLTableElement; ctx: TableCtx } | null = null;
  private raf = 0;
  private lastEvent: MouseEvent | null = null;
  /** 最近一次显示的命中（迟滞：鼠标小幅移动仍保持显示）。 */
  private activeHit: {
    type: 'row-boundary' | 'col-boundary' | 'row-handle' | 'col-handle' | 'corner';
    index?: number;
    rowIndex?: number;
    colIndex?: number;
    ax: number;
    ay: number;
  } | null = null;
  /** 跨单元格拖动拦截：记录按下时的单元格，拖动到其他单元格时阻止（禁用区域拖选）。 */
  private dragStartCell: HTMLElement | null = null;
  /** 行列选中轮廓线（四条边独立绘制，避免 border-collapse 合并丢边）。 */
  private selLines: HTMLElement[] = [];
  /** 诊断：最近一次显示的元素，变化时才打日志。 */
  private lastLogKey = '';

  private static KEEP_TOL = 16;

  constructor(view: EditorView) {
    this.view = view;
    const host = (view.dom.parentElement ?? document.body) as HTMLElement;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    this.overlay = document.createElement('div');
    this.overlay.className = 'mdw-table-gutter';
    host.appendChild(this.overlay);

    this.rowPlus = this.mk('mdw-tg-dot', 'row');
    this.colPlus = this.mk('mdw-tg-dot', 'col');
    this.rowLine = this.mk('mdw-tg-line row', 'row');
    this.colLine = this.mk('mdw-tg-line col', 'col');
    this.rowHandle = this.mk('mdw-tg-handle row', 'row');
    this.colHandle = this.mk('mdw-tg-handle col', 'col');

    this.menu = document.createElement('div');
    this.menu.className = 'mdw-tg-menu';
    this.overlay.appendChild(this.menu);

    window.addEventListener('mousemove', this.onMove, true);
    document.addEventListener('mousedown', this.onDocDown, true);
    // 跨单元格拖动拦截（捕获阶段）：mousedown 在单元格上、拖动到别的单元格 → 阻止，
    // 从而禁用 tableEditing 的区域拖选；单元格内文字拖选不受影响。
    view.root.addEventListener('mousedown', this.onRootMouseDown, true);
    view.root.addEventListener('mousemove', this.onRootMouseMove, true);
    view.root.addEventListener('mouseup', this.onRootMouseUp, true);
    // 原生拖放拦截（捕获阶段，直接挂在 root 上，绕开 ProseMirror 的插件链，保证一定执行）：
    // - dragstart：起点在单元格内或当前为整行/整列选中 → 取消原生拖动（否则浏览器会把跨格
    //   选区序列化成 <table> HTML，拖到表格下方直接新建一个表格）；
    // - drop：内容含表格结构或落点在单元格内 → 取消插入。
    view.root.addEventListener('dragstart', this.onDomDragStart, true);
    view.root.addEventListener('drop', this.onDomDrop, true);
    // Ctrl+A 捕获（window + document 双捕获，不依赖 keymap 插件顺序）：
    // 只要选区当前在表格中 → 只选中整张表，阻止浏览器原生 select-all（整篇全选）。
    window.addEventListener('keydown', this.onDomKeyDown, true);
    view.root.addEventListener('keydown', this.onDomKeyDown, true);
    // ctx 缓存失效：任何滚动（捕获阶段可收到所有元素的 scroll）、窗口缩放后表格几何都会变
    window.addEventListener('scroll', this.invalidateCtx, true);
    window.addEventListener('resize', this.invalidateCtx);
    console.log('[table-gutter] initialized (host:', host.className, ')');
  }

  /** 使 ctx 缓存失效（滚动、窗口缩放、编辑事务后表格几何可能变化）。 */
  private invalidateCtx = (): void => {
    this.ctxCache = null;
  };

  private onRootMouseDown = (e: Event): void => {
    this.dragStartCell = (eventTargetEl(e.target)?.closest('td,th') as HTMLElement | null) ?? null;
  };

  private onRootMouseMove = (e: Event): void => {
    const t = eventTargetEl(e.target);
    if (!t) return;
    // 手柄拖动期间：指示线由拖动逻辑自己管理，本层（拦截拖选进表格）不再介入。
    // 否则捕获阶段在 document 上 stopImmediatePropagation 会让 window 冒泡阶段的
    // 拖动 onMove 收不到事件 → 指示线在鼠标进入表格后冻结、松手落到旧位置（表现为"拖动很卡"）。
    if (this.dragState) return;
    if (this.dragStartCell) {
      // 只要指针不在按下时的单元格内就拦截（目标可能是别的单元格、覆盖层元素、边框等，
      // 一律视为拖出单元格）→ 阻止 tableEditing 的跨格选中与浏览器原生选区
      const inside = this.dragStartCell.contains(t);
      if (!inside) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
      return;
    }
    // 从表格外（如表格下方的段落）按住左键向上拖选、指针进入表格 → 阻止，
    // 防止浏览器原生选区把"表格 + 表格后的内容"一起选上（复制粘贴时句子会混进格子）。
    if ((e as MouseEvent).buttons === 1) {
      const tableEl = t.closest('table');
      if (tableEl && this.view.dom.contains(tableEl)) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }
  };

  private onRootMouseUp = (): void => {
    this.dragStartCell = null;
  };

  /** 原生 dragstart 捕获：起点在单元格内 / 整行整列选中 → 取消整个拖动。 */
  private onDomDragStart = (e: Event): void => {
    const ev = e as DragEvent;
    const el = eventTargetEl(ev.target);
    if (shouldBlockDragStart(this.view.state.selection, el)) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      this.log('drag-block', 'dragstart prevented');
    }
  };

  /** 原生 drop 捕获：内容含表格结构或落点在单元格内 → 取消插入。 */
  private onDomDrop = (e: Event): void => {
    const ev = e as DragEvent;
    const el = eventTargetEl(ev.target);
    let html = '';
    try {
      html = ev.dataTransfer?.getData('text/html') ?? '';
    } catch {
      /* 某些浏览器在 drop 前读取受限，忽略 */
    }
    if (shouldBlockDrop(html, el)) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      this.log('drop-block', html ? 'table markup' : 'drop into cell');
    }
  };

  /** Ctrl+A 捕获：选区在表格中 → 只选中整张表（阻止浏览器原生整篇全选）。 */
  private onDomKeyDown = (e: Event): void => {
    const ev = e as KeyboardEvent;
    if (ev.key.toLowerCase() !== 'a' || (!ev.ctrlKey && !ev.metaKey) || ev.shiftKey || ev.altKey) return;
    const tr = wholeTableTr(this.view.state);
    if (!tr) return;
    this.log('keydown ctrl+a', 'dispatch whole-table selection');
    this.view.dispatch(tr);
    ev.preventDefault();
    ev.stopImmediatePropagation();
  };

  private mk(className: string, kind: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = className;
    el.dataset.kind = kind;
    el.style.display = 'none';
    this.overlay.appendChild(el);
    el.addEventListener('click', (e) => this.onElementClick(e, kind));
    if (className.includes('mdw-tg-handle')) {
      el.addEventListener('mousedown', (e) => this.onHandleDown(e, kind));
    }
    return el;
  }

  /** 手柄按下：移动超过阈值视为拖动（移动列/行），否则视为点击（打开菜单）。 */
  private onHandleDown(e: MouseEvent, kind: string): void {
    const target = e.currentTarget as HTMLElement;
    const ctx = this.ctx;
    if (!ctx || (kind !== 'row' && kind !== 'col')) return;
    const index = Number(target.dataset.index ?? -1);
    if (index < 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    this.dragState = { kind, index, dragging: false };
    let targetIndex = index;
    // 拖动指示线 rAF 节流：同一帧内的多次 mousemove 只重算一次落点（高回报率鼠标/高刷屏避免每事件写样式）
    let pending: { x: number; y: number } | null = null;
    let raf = 0;

    const onMove = (ev: MouseEvent) => {
      const st = this.dragState;
      if (!st) return;
      if (!st.dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4) {
        st.dragging = true;
        this.closeMenu();
        this.hideBoundaries();
        target.classList.add('dragging');
      }
      if (!st.dragging) return;
      pending = { x: ev.clientX, y: ev.clientY };
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const p = pending;
        pending = null;
        const cur = this.dragState;
        if (!p || !cur || !cur.dragging || cur.kind !== kind) return;
        targetIndex =
          cur.kind === 'col'
            ? this.nearestBoundary(ctx, cur.kind, p.x)
            : this.nearestBoundary(ctx, cur.kind, p.y);
        this.showDropIndicator(ctx, cur.kind, targetIndex);
      });
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const st = this.dragState;
      this.dragState = null;
      target.classList.remove('dragging');
      this.hideDropIndicator();
      if (st?.dragging) {
        // 拖动结束：移动列/行，并吞掉随后的 click
        this.moveLine(ctx, st.kind, st.index, targetIndex);
        this.suppressNextClick = true;
      }
      void ev;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  /** 最近的目标边界下标（拖动落点 = 距离鼠标最近的行/列边界）。 */
  private nearestBoundary(ctx: TableCtx, kind: 'row' | 'col', pos: number): number {
    const count = kind === 'col' ? ctx.cols.length : ctx.rows.length;
    let best = 0;
    let bestDist = Infinity;
    for (let j = 0; j <= count; j++) {
      const p =
        kind === 'col'
          ? this.boundaryColX(ctx, j)
          : this.boundaryRowY(ctx, j);
      const d = Math.abs(pos - p);
      if (d < bestDist) {
        bestDist = d;
        best = j;
      }
    }
    return best;
  }

  /** 拖动时显示落点指示线（两列/两行之间高亮）。 */
  private showDropIndicator(ctx: TableCtx, kind: 'row' | 'col', index: number): void {
    if (kind === 'col') {
      const x = this.boundaryColX(ctx, index);
      this.colLine.classList.add('drop');
      this.colLine.style.display = 'block';
      this.colLine.style.height = `${ctx.rows[ctx.rows.length - 1].bottom - ctx.rows[0].top}px`;
      this.colLine.style.left = `${this.lx(ctx, x) - 1}px`;
      this.colLine.style.top = `${this.ly(ctx, ctx.rows[0].top)}px`;
    } else {
      const y = this.boundaryRowY(ctx, index);
      this.rowLine.classList.add('drop');
      this.rowLine.style.display = 'block';
      this.rowLine.style.width = `${ctx.contentRight - ctx.contentLeft}px`;
      this.rowLine.style.left = `${this.lx(ctx, ctx.contentLeft)}px`;
      this.rowLine.style.top = `${this.ly(ctx, y) - 1}px`;
    }
  }

  private hideDropIndicator(): void {
    this.colLine.classList.remove('drop');
    this.rowLine.classList.remove('drop');
    this.hideBoundaries();
  }

  /** 拖动落点 → 移动列/行（单事务：显式传 pos 定位表格，不依赖当前选区；
   *  moveTableRow/Column 默认 select:true 会自行选中移动后的行/列）。 */
  private moveLine(ctx: TableCtx, kind: 'row' | 'col', from: number, boundary: number): void {
    // 落点边界 boundary：before 列/行 boundary。新下标 = boundary <= from ? boundary : boundary - 1
    const newIndex = boundary <= from ? boundary : boundary - 1;
    if (newIndex === from || newIndex < 0) return;
    const view = this.view;
    if (kind === 'col') {
      moveTableColumn({ from, to: newIndex, pos: ctx.pos + 1 })(view.state, view.dispatch);
    } else {
      moveTableRow({ from, to: newIndex, pos: ctx.pos + 1 })(view.state, view.dispatch);
    }
  }

  private onMove = (e: MouseEvent) => {
    this.lastEvent = e;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.lastEvent) {
        try {
          this.handleMove(this.lastEvent);
        } catch (err) {
          console.error('[table-gutter] handleMove error', err);
        }
      }
    });
  };

  private log(key: string, detail?: string): void {
    if (key === this.lastLogKey) return;
    this.lastLogKey = key;
    console.log(`[table-gutter] ${key}${detail ? ' | ' + detail : ''}`);
  }

  private handleMove(e: MouseEvent): void {
    const { clientX: mx, clientY: my } = e;
    const overMenu = this.menu.style.display !== 'none' && this.menu.contains(e.target as Node);
    if (overMenu) return;
    // 菜单打开期间：鼠标移动不改变手柄/菜单显示
    if (this.menuOpen) return;
    // 拖动期间：由拖动逻辑管理指示线，跳过常规命中
    if (this.dragState) return;

    const target = document.elementFromPoint(mx, my);
    if (target instanceof HTMLElement && this.overlay.contains(target) && target !== this.menu) {
      const kind = target.dataset.kind as 'row' | 'col';
      const ctx = this.ctx;
      if (ctx) {
        if (target.classList.contains('mdw-tg-dot')) {
          const index = Number(target.dataset.index ?? 0);
          if (kind === 'row') this.showRowBoundary(ctx, Math.min(ctx.rows.length, index), true);
          else this.showColBoundary(ctx, Math.min(ctx.cols.length, index), true);
        } else if (target.classList.contains('mdw-tg-handle')) {
          const index = Number(target.dataset.index ?? 0);
          this.hideBoundaries();
          if (kind === 'row') this.positionHandle(ctx, 'row', Math.min(ctx.rows.length - 1, index));
          else this.positionHandle(ctx, 'col', Math.min(ctx.cols.length - 1, index));
        }
      }
      return;
    }

    const tableEl = target instanceof Element ? target.closest('table') : null;
    if (!tableEl || !this.view.dom.contains(tableEl)) {
      this.hideAll();
      this.closeMenu();
      return;
    }
    // 复用缓存 ctx：同一表格元素且几何未变（未滚动/缩放/编辑）时不做全表测量
    let ctx = this.ctxCache && this.ctxCache.el === tableEl ? this.ctxCache.ctx : null;
    if (!ctx) {
      ctx = this.buildCtx(tableEl as HTMLTableElement);
      if (ctx) this.ctxCache = { el: tableEl as HTMLTableElement, ctx };
    }
    if (!ctx) {
      this.log('ctx-null', 'buildCtx failed');
      this.hideAll();
      return;
    }
    this.ctx = ctx;
    const freshHit = hitTest(mx, my, ctx.rect, ctx.rows, ctx.cols);
    let hit: GutHit = freshHit;
    if (hit.type === null && this.activeHit) {
      const a = this.activeHit;
      if (Math.hypot(mx - a.ax, my - a.ay) <= TableGutterView.KEEP_TOL) {
        hit = { type: a.type, index: a.index, rowIndex: a.rowIndex, colIndex: a.colIndex } as GutHit;
      }
    }
    switch (hit.type) {
      case 'row-boundary':
        this.activeHit = { type: 'row-boundary', index: hit.index, ax: ctx.contentLeft, ay: this.boundaryRowY(ctx, hit.index) };
        this.log('row-boundary', `index=${hit.index} lineW=${(ctx.contentRight - ctx.contentLeft).toFixed(0)}px`);
        this.showRowBoundary(ctx, hit.index, true);
        break;
      case 'col-boundary':
        this.activeHit = { type: 'col-boundary', index: hit.index, ax: this.boundaryColX(ctx, hit.index), ay: ctx.rows[0].top };
        this.log('col-boundary', `index=${hit.index} lineH=${(ctx.rows[ctx.rows.length - 1].bottom - ctx.rows[0].top).toFixed(0)}px`);
        this.showColBoundary(ctx, hit.index, true);
        break;
      case 'row-handle':
        this.activeHit = { type: 'row-handle', index: hit.index, ax: ctx.contentLeft, ay: ctx.rows[hit.index].center };
        this.hideBoundaries();
        this.log('row-handle', `index=${hit.index}`);
        this.positionHandle(ctx, 'row', hit.index);
        break;
      case 'col-handle':
        this.activeHit = { type: 'col-handle', index: hit.index, ax: ctx.cols[hit.index].center, ay: ctx.rows[0].top };
        this.hideBoundaries();
        this.log('col-handle', `index=${hit.index}`);
        this.positionHandle(ctx, 'col', hit.index);
        break;
      default:
        this.activeHit = null;
        this.hideAll();
        break;
    }
  }

  private boundaryRowY(ctx: TableCtx, index: number): number {
    return index === ctx.rows.length ? ctx.rows[ctx.rows.length - 1].bottom : ctx.rows[index].top;
  }

  private boundaryColX(ctx: TableCtx, index: number): number {
    return index === ctx.cols.length ? ctx.cols[ctx.cols.length - 1].right : ctx.cols[index].left;
  }

  private buildCtx(tableEl: HTMLTableElement): TableCtx | null {
    try {
      const host = (this.view.dom.parentElement ?? document.body) as HTMLElement;
      const hostRect = host.getBoundingClientRect();
      const rect = tableEl.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        this.log('ctx-null', 'table rect is zero size');
        return null;
      }
      const rows: RowRect[] = [];
      let contentLeft = Infinity;
      let contentRight = -Infinity;
      tableEl.querySelectorAll('tr').forEach((tr) => {
        const cells = tr.querySelectorAll('td,th');
        if (!cells.length) return;
        let top = Infinity;
        let bottom = -Infinity;
        cells.forEach((c) => {
          const r = c.getBoundingClientRect();
          top = Math.min(top, r.top);
          bottom = Math.max(bottom, r.bottom);
          contentLeft = Math.min(contentLeft, r.left);
          contentRight = Math.max(contentRight, r.right);
        });
        rows.push({ top, center: (top + bottom) / 2, bottom });
      });
      const firstRow = tableEl.querySelector('tr');
      const cols: ColRect[] = [];
      if (firstRow) {
        firstRow.querySelectorAll('td,th').forEach((td) => {
          const r = td.getBoundingClientRect();
          cols.push({ left: r.left, center: r.left + r.width / 2, right: r.right });
        });
      }
      const firstCell = tableEl.querySelector('td,th');
      let pos = -1;
      if (firstCell) {
        const cellPos = this.view.posAtDOM(firstCell, 0);
        const $resolved = this.view.state.doc.resolve(cellPos);
        for (let d = $resolved.depth; d > 0; d--) {
          if ($resolved.node(d).type.name === 'table') {
            pos = $resolved.before(d);
            break;
          }
        }
      }
      if (pos < 0 || rows.length === 0 || cols.length === 0) {
        this.log('ctx-null', `pos=${pos} rows=${rows.length} cols=${cols.length}`);
        return null;
      }
      return {
        el: tableEl,
        hostRect,
        rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height },
        contentLeft,
        contentRight,
        rows,
        cols,
        pos,
      };
    } catch (err) {
      this.log('ctx-null', 'exception: ' + String(err));
      return null;
    }
  }

  private lx(ctx: TableCtx, x: number): number {
    return x - ctx.hostRect.left;
  }
  private ly(ctx: TableCtx, y: number): number {
    return y - ctx.hostRect.top;
  }

  /** 行边界：+ 在左缘、插入线横贯单元格实际宽度。 */
  private showRowBoundary(ctx: TableCtx, index: number, withLine = false): void {
    const y = this.boundaryRowY(ctx, index);
    this.rowPlus.dataset.index = String(index);
    this.rowPlus.style.display = 'flex';
    this.rowPlus.style.left = `${this.lx(ctx, ctx.contentLeft) - 7}px`;
    this.rowPlus.style.top = `${this.ly(ctx, y) - 7}px`;
    if (withLine) {
      this.rowLine.style.display = 'block';
      this.rowLine.style.width = `${ctx.contentRight - ctx.contentLeft}px`;
      this.rowLine.style.left = `${this.lx(ctx, ctx.contentLeft)}px`;
      this.rowLine.style.top = `${this.ly(ctx, y) - 1}px`;
    } else {
      this.rowLine.style.display = 'none';
    }
    this.colPlus.style.display = 'none';
    this.colLine.style.display = 'none';
    this.hideHandles();
  }

  /** 列边界：+ 在上缘、插入线纵贯单元格实际高度。 */
  private showColBoundary(ctx: TableCtx, index: number, withLine = false): void {
    const x = this.boundaryColX(ctx, index);
    const top = ctx.rows[0].top;
    const bottom = ctx.rows[ctx.rows.length - 1].bottom;
    this.colPlus.dataset.index = String(index);
    this.colPlus.style.display = 'flex';
    this.colPlus.style.left = `${this.lx(ctx, x) - 7}px`;
    this.colPlus.style.top = `${this.ly(ctx, top) - 7}px`;
    if (withLine) {
      this.colLine.style.display = 'block';
      this.colLine.style.height = `${bottom - top}px`;
      this.colLine.style.left = `${this.lx(ctx, x) - 1}px`;
      this.colLine.style.top = `${this.ly(ctx, top)}px`;
    } else {
      this.colLine.style.display = 'none';
    }
    this.rowPlus.style.display = 'none';
    this.rowLine.style.display = 'none';
    this.hideHandles();
  }

  private hideBoundaries(): void {
    this.rowPlus.style.display = 'none';
    this.colPlus.style.display = 'none';
    this.rowLine.style.display = 'none';
    this.colLine.style.display = 'none';
  }

  private hideHandles(): void {
    this.rowHandle.style.display = 'none';
    this.colHandle.style.display = 'none';
  }

  private positionHandle(ctx: TableCtx, kind: 'row' | 'col', index: number): void {
    if (kind === 'row') {
      const row = ctx.rows[index];
      this.rowHandle.dataset.index = String(index);
      this.rowHandle.style.display = 'flex';
      this.rowHandle.style.left = `${this.lx(ctx, ctx.contentLeft) - 7}px`;
      this.rowHandle.style.top = `${this.ly(ctx, row.center) - 10}px`;
      this.colHandle.style.display = 'none';
    } else {
      const col = ctx.cols[index];
      this.colHandle.dataset.index = String(index);
      this.colHandle.style.display = 'flex';
      this.colHandle.style.left = `${this.lx(ctx, col.center) - 10}px`;
      this.colHandle.style.top = `${this.ly(ctx, ctx.rows[0].top) - 7}px`;
      this.rowHandle.style.display = 'none';
    }
  }

  private onElementClick(e: MouseEvent, kind: string): void {
    const target = e.currentTarget as HTMLElement;
    const ctx = this.ctx;
    if (!ctx) return;
    const index = Number(target.dataset.index ?? -1);
    if (kind === 'row' && target.classList.contains('mdw-tg-dot')) {
      this.insertRowAt(ctx, index);
      return;
    }
    if (kind === 'col' && target.classList.contains('mdw-tg-dot')) {
      this.insertColAt(ctx, index);
      return;
    }
    if (kind === 'row' && target.classList.contains('mdw-tg-handle')) {
      if (this.suppressNextClick) {
        this.suppressNextClick = false; // 拖动后的 click，吞掉
        return;
      }
      this.selectAndMenu(ctx, 'row', index);
      return;
    }
    if (kind === 'col' && target.classList.contains('mdw-tg-handle')) {
      if (this.suppressNextClick) {
        this.suppressNextClick = false;
        return;
      }
      this.selectAndMenu(ctx, 'col', index);
      return;
    }
  }

  private onDocDown = (e: MouseEvent): void => {
    if (this.menu.style.display !== 'none' && !this.menu.contains(e.target as Node)) {
      this.closeMenu();
    }
  };

  /** 定位当前表格节点（返回 node 与 start=内容起始位置）。 */
  private currentTable(view: EditorView): { node: any; start: number; nodeStart: number } | null {
    try {
      const $pos = view.state.doc.resolve((this.ctx?.pos ?? 0) + 1);
      for (let d = $pos.depth; d >= 0; d--) {
        if ($pos.node(d).type.name === 'table') {
          return { node: $pos.node(d), start: $pos.start(d), nodeStart: $pos.before(d) };
        }
      }
    } catch {
      /* 忽略 */
    }
    return null;
  }

  /** 单事务插入一行：插入 + 光标放入新行第一格，一次撤销正好一步、无选中残留。 */
  private insertRowAt(ctx: TableCtx, index: number): void {
    const view = this.view;
    const t = this.currentTable(view);
    if (!t) return;
    try {
      const map = TableMap.get(t.node);
      let tr = view.state.tr;
      tr = addRow(tr, { map, tableStart: t.start, table: t.node } as any, index);
      const newTable = tr.doc.nodeAt(t.nodeStart);
      if (newTable) {
        const map2 = TableMap.get(newTable);
        const cell = map2.positionAt(index, 0, newTable);
        const $cell = tr.doc.resolve(t.start + cell + 1);
        tr = tr.setSelection(TextSelection.near($cell));
      }
      view.dispatch(tr);
    } catch (err) {
      console.error('[table-gutter] insertRow failed', err);
    }
  }

  /** 单事务插入一列：插入 + 光标放入新列第一格。 */
  private insertColAt(ctx: TableCtx, index: number): void {
    const view = this.view;
    const t = this.currentTable(view);
    if (!t) return;
    try {
      const map = TableMap.get(t.node);
      let tr = view.state.tr;
      tr = addColumn(tr, { map, tableStart: t.start, table: t.node } as any, index);
      const newTable = tr.doc.nodeAt(t.nodeStart);
      if (newTable) {
        const map2 = TableMap.get(newTable);
        const cell = map2.positionAt(0, index, newTable);
        const $cell = tr.doc.resolve(t.start + cell + 1);
        tr = tr.setSelection(TextSelection.near($cell));
      }
      view.dispatch(tr);
    } catch (err) {
      console.error('[table-gutter] insertCol failed', err);
    }
  }

  private selectAndMenu(ctx: TableCtx, kind: 'row' | 'col', index: number): void {
    const view = this.view;
    const tr =
      kind === 'row'
        ? selectRow(index, ctx.pos + 1)(view.state.tr)
        : selectCol(index, ctx.pos + 1)(view.state.tr);
    view.dispatch(tr);
    this.menuKind = kind;
    this.menuIndex = index;
    this.menuOpen = true;
    // 打开菜单时高亮手柄
    this.rowHandle.classList.remove('active');
    this.colHandle.classList.remove('active');
    (kind === 'row' ? this.rowHandle : this.colHandle).classList.add('active');
    this.renderMenu();
    const handle = kind === 'row' ? this.rowHandle : this.colHandle;
    const h = handle.getBoundingClientRect();
    const hostRect = ctx.hostRect;
    // 行手柄：菜单向右展开（避免伸到左侧大纲区域）；列手柄：向下展开并对齐手柄左缘
    let left = kind === 'row' ? h.right - hostRect.left + 4 : h.left - hostRect.left;
    left = Math.max(4, Math.min(left, hostRect.width - 180 - 4));
    this.menu.style.display = 'flex';
    this.menu.style.left = `${left}px`;
    this.menu.style.top = `${h.bottom - hostRect.top + 4}px`;
    this.menu.style.transform = '';
  }

  private renderMenu(): void {
    this.menu.innerHTML = '';
    const kind = this.menuKind;
    const index = this.menuIndex;
    const pos = (this.ctx?.pos ?? 0) + 1;
    const add = (iconKey: string, label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mdw-tg-menu-item';
      const iconSpan = document.createElement('span');
      iconSpan.className = 'mdw-tg-menu-icon';
      iconSpan.innerHTML = MENU_ICONS[iconKey] ?? '';
      const labelSpan = document.createElement('span');
      labelSpan.textContent = label;
      b.append(iconSpan, labelSpan);
      b.addEventListener('click', () => {
        fn();
        this.closeMenu();
        // 表格结构已变：立即隐藏手柄/边界，避免停留在旧行/旧列位置
        this.hideAll();
      });
      this.menu.appendChild(b);
    };
    const view = this.view;
    const selectLine = (isRow: boolean) => {
      let tr = isRow ? selectRow(index, pos)(view.state.tr) : selectCol(index, pos)(view.state.tr);
      view.dispatch(tr);
    };
    if (kind === 'row') {
      add('insertAbove', '上方插入行', () => {
        selectLine(true);
        addRowBefore(view.state, view.dispatch);
      });
      add('insertBelow', '下方插入行', () => {
        selectLine(true);
        addRowAfter(view.state, view.dispatch);
      });
      add('delete', '删除行', () => {
        selectLine(true);
        deleteRow(view.state, view.dispatch);
      });
      add('moveUp', '整行上移', () => {
        selectLine(true);
        moveTableRow({ from: index, to: index - 1 })(view.state, view.dispatch);
      });
      add('moveDown', '整行下移', () => {
        selectLine(true);
        moveTableRow({ from: index, to: index + 1 })(view.state, view.dispatch);
      });
    } else {
      add('insertLeft', '左侧插入列', () => {
        selectLine(false);
        addColumnBefore(view.state, view.dispatch);
      });
      add('insertRight', '右侧插入列', () => {
        selectLine(false);
        addColumnAfter(view.state, view.dispatch);
      });
      add('delete', '删除列', () => {
        selectLine(false);
        deleteColumn(view.state, view.dispatch);
      });
      add('moveLeft', '整列左移', () => {
        selectLine(false);
        moveTableColumn({ from: index, to: index - 1 })(view.state, view.dispatch);
      });
      add('moveRight', '整列右移', () => {
        selectLine(false);
        moveTableColumn({ from: index, to: index + 1 })(view.state, view.dispatch);
      });
      // 对齐只对列有意义，仅列菜单提供
      add('alignLeft', '左对齐', () => {
        setCellAttr('alignment', 'left')(view.state, view.dispatch);
      });
      add('alignCenter', '居中', () => {
        setCellAttr('alignment', 'center')(view.state, view.dispatch);
      });
      add('alignRight', '右对齐', () => {
        setCellAttr('alignment', 'right')(view.state, view.dispatch);
      });
    }
  }

  private closeMenu(): void {
    this.menu.style.display = 'none';
    this.menuKind = null;
    this.menuOpen = false;
    this.rowHandle.classList.remove('active');
    this.colHandle.classList.remove('active');
  }

  private hideAll(): void {
    this.activeHit = null;
    this.hideBoundaries();
    this.hideHandles();
  }

  /** 行列选中网格线（外框 + 单元格间线，单线 1px；背景高亮由 .selectedCell 类 + CSS 完成）。 */
  syncSelection(view: EditorView): void {
    // 每次事务（编辑/选择）后表格几何可能变化：失效 ctx 缓存，下次悬停重建
    this.invalidateCtx();
    this.hideSelOutline();
    const sel = view.state.selection as any;
    if (!sel.$anchorCell || !sel.$headCell) return;
    const table = findTable(sel.$anchorCell);
    if (!table) return;
    try {
      const map = TableMap.get(table.node);
      const rect = map.rectBetween(
        sel.$anchorCell.pos - table.start,
        sel.$headCell.pos - table.start
      );
      const cells = map.cellsInRect(rect);
      const host = (view.dom.parentElement ?? document.body) as HTMLElement;
      const hostRect = host.getBoundingClientRect();
      const vXs = new Set<number>();
      const hYs = new Set<number>();
      let top = Infinity;
      let bottom = -Infinity;
      let left = Infinity;
      let right = -Infinity;
      for (const pos of cells) {
        const dom = view.nodeDOM(table.start + pos) as HTMLElement | null;
        if (!dom) continue;
        // 注意：不要直接修改 ProseMirror 内容 DOM（style/class）——会触发观察器死循环。
        // 背景高亮由 tableEditing 原生添加的 .selectedCell 类 + CSS 完成。
        const r = dom.getBoundingClientRect();
        vXs.add(r.left);
        hYs.add(r.top);
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
        left = Math.min(left, r.left);
        right = Math.max(right, r.right);
      }
      if (!isFinite(top) || !isFinite(left)) return;
      vXs.add(right);
      hYs.add(bottom);
      const L = left - hostRect.left;
      const T = top - hostRect.top;
      const W = right - left;
      const H = bottom - top;
      const mk = (orient: 'v' | 'h', x: number, y: number, size: number) => {
        const el = document.createElement('div');
        el.className = 'mdw-tg-sel-line ' + orient;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        if (orient === 'v') el.style.height = `${size}px`;
        else el.style.width = `${size}px`;
        return el;
      };
      const lines: HTMLElement[] = [];
      for (const x of [...vXs].sort((a, b) => a - b)) {
        lines.push(mk('v', x - hostRect.left - 0.5, T, H));
      }
      for (const y of [...hYs].sort((a, b) => a - b)) {
        lines.push(mk('h', L, y - hostRect.top - 0.5, W));
      }
      this.selLines = lines;
      for (const el of lines) this.overlay.appendChild(el);
    } catch {
      this.hideSelOutline();
    }
  }

  private hideSelOutline(): void {
    for (const el of this.selLines) el.remove();
    this.selLines = [];
  }

  destroy(): void {
    window.removeEventListener('mousemove', this.onMove, true);
    document.removeEventListener('mousedown', this.onDocDown, true);
    this.view.root.removeEventListener('mousedown', this.onRootMouseDown, true);
    this.view.root.removeEventListener('mousemove', this.onRootMouseMove, true);
    this.view.root.removeEventListener('mouseup', this.onRootMouseUp, true);
    this.view.root.removeEventListener('dragstart', this.onDomDragStart, true);
    this.view.root.removeEventListener('drop', this.onDomDrop, true);
    window.removeEventListener('keydown', this.onDomKeyDown, true);
    this.view.root.removeEventListener('keydown', this.onDomKeyDown, true);
    window.removeEventListener('scroll', this.invalidateCtx, true);
    window.removeEventListener('resize', this.invalidateCtx);
    this.overlay.remove();
    if (this.raf) cancelAnimationFrame(this.raf);
  }
}

export const tableGutterPlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('mdwTableGutter'),
    // 事务级兜底：任何路径产生了"整篇全选"（浏览器原生 select-all 由 DOMObserver
    // 同步而来、或任意 selectAll 命令），且选中前选区在表格内 → 改写为整表 CellSelection。
    // 这样即使 keydown 拦截全部失效（如 VS Code 在宿主层吞掉 Ctrl+A），结果依然正确。
    appendTransaction: (trs, oldState, newState) => {
      const sel: any = newState.selection;
      if (!(sel instanceof TextSelection) || sel.empty) return null;
      if (sel.from !== 0 || sel.to !== newState.doc.content.size) return null;
      const old: any = oldState.selection;
      const $oldHead = old.$headCell ?? old.$head;
      if (!$oldHead || !findTable($oldHead)) return null;
      const tr = wholeTableTr(newState);
      if (!tr) return null;
      console.log('[table-gutter] select-all converted to whole-table selection');
      return tr;
    },
    // 表格相关原生拖放的多层保险（主拦截在 TableGutterView 的 root 捕获监听，这里兜底）：
    // - dragstart：起点在单元格内，或当前是整行/整列选中（CellSelection）时，一律禁止拖动；
    // - handleDrop：拖放内容包含表格节点、或落点在表格内 → 一律拒绝插入。
    props: {
      handleDOMEvents: {
        dragstart: (view, event) => {
          const el = eventTargetEl(event.target);
          if (shouldBlockDragStart(view.state.selection, el)) {
            event.preventDefault();
            return true;
          }
          return false;
        },
      },
      handleDrop: (view, event, slice, _moved) => {
        // 拖放内容里含表格结构 → 一律拒绝（防止在表格下方新建表格/列等未知结构变化）
        if (sliceHasTable(slice)) {
          event.preventDefault();
          return true;
        }
        const coords = { left: event.clientX, top: event.clientY };
        const pos = view.posAtCoords(coords);
        if (!pos) return false;
        const $resolved = view.state.doc.resolve(pos.pos);
        for (let d = $resolved.depth; d >= 0; d--) {
          if ($resolved.node(d).type.name === 'table') {
            event.preventDefault();
            return true;
          }
        }
        return false;
      },
    },
    view: (view) => {
      const gutter = new TableGutterView(view);
      return {
        update: (v: EditorView) => gutter.syncSelection(v),
        destroy: () => gutter.destroy(),
      };
    },
  });
});

/** 当前选区是否落在某张表格内（返回表格信息）。 */
function tableOfSelection(state: any): { node: any; start: number } | null {
  const sel = state.selection;
  const $head = sel.$headCell ?? sel.$head;
  if (!$head) return null;
  return findTable($head);
}

/** 构造"选中整张表"的事务；不在表格内或构造失败返回 null。 */
function wholeTableTr(state: any): any | null {
  const table = tableOfSelection(state);
  if (!table) return null;
  try {
    const { node, start } = table;
    const map = TableMap.get(node);
    // findTable 的 start = 表格节点位置；positionAt 返回相对表格内容起点的偏移，
    // 单元格的"选中位置"（parent=row、nodeAfter=cell）= start + 偏移。
    const first = map.positionAt(0, 0, node);
    const last = map.positionAt(map.height - 1, map.width - 1, node);
    const anchor = state.doc.resolve(start + first);
    const head = state.doc.resolve(start + last);
    return state.tr.setSelection(new CellSelection(anchor, head));
  } catch (err) {
    console.error('[table-gutter] whole-table selection failed', err);
    return null;
  }
}

/**
 * Ctrl+A（全选）在表格内 → 只选中整张表（CellSelection），而不是整篇文档。
 * 否则用户"选中整个表格的文字"会连同表格后面的句子一起选中，复制粘贴时
 * 句子会被 handlePaste 塞进单元格（右下角格子里出现表格后的内容）。
 * 主拦截在 TableGutterView 的 root 捕获 keydown（不依赖插件顺序），
 * 这里作为 ProseMirror 层兜底（需排在 baseKeymap 之前）。
 */
export const tableSelectAllPlugin = $prose(() =>
  keymap({
    'Mod-a': (state, dispatch) => {
      const tr = wholeTableTr(state);
      if (!tr) return false;
      if (dispatch) dispatch(tr);
      return true;
    },
  })
);

/**
 * 粘贴守卫：粘贴内容含表格节点、且目标在表格内时 → 用粘贴内容整体替换当前整张表。
 * 必须排在 tableEditing（gfm）的 handlePaste 之前：
 * - 否则 tableEditing 会把"表格+其他内容"的混合切片包进一个格子再重复填满选区，
 *   导致表格后的句子出现在每个格子（含右下角）里；
 * - 光标在单元格内粘贴含表格的内容时，也会被嵌套进该格子。
 */
export const tablePasteGuardPlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('mdwTablePasteGuard'),
    props: {
      handlePaste: (view, event, slice) => {
        if (!sliceHasTable(slice)) return false;
        const sel = view.state.selection as any;
        const $head = sel.$headCell ?? sel.$head;
        if (!$head) return false;
        const table = findTable($head);
        if (!table) return false;
        const { node, start } = table;
        const tablePos = start - 1;
        view.dispatch(
          view.state.tr
            .replace(tablePos, tablePos + node.nodeSize, slice)
            .scrollIntoView()
            .setMeta('paste', true)
        );
        return true;
      },
    },
  });
});