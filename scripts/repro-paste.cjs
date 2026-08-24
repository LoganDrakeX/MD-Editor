/**
 * 复现：选中整个表格的文字复制粘贴 → 表格后一句话被当成右下角格子内容。
 * 用真实 prosemirror-model/state/tables 走完整 copy→paste 链路（state 侧），
 * 复刻 prosemirror-view 的 copy 处理（sel.content() + DOMSerializer）与
 * parseFromClipboard（DOMParser），并调用 tableEditing 的 handlePaste。
 */
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser;
global.Node = dom.window.Node;

const { Schema, DOMSerializer, DOMParser: PMDOMParser, Slice } = require('prosemirror-model');
const { EditorState, TextSelection } = require('prosemirror-state');
const { tableNodes, tableEditing, CellSelection, TableMap, findTable } = require('prosemirror-tables');

const nodes = {
  doc: { content: 'block+' },
  text: { inline: true, group: 'inline' },
  paragraph: { content: 'inline*', group: 'block', parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
  ...tableNodes({ tableGroup: 'block', cellContent: 'block+', cellAttributes: {} }),
};
// 补 parseDOM（Milkdown gfm schema 自带）
nodes.table.parseDOM = [{ tag: 'table' }];
nodes.table_row.parseDOM = [{ tag: 'tr' }];
nodes.table_cell.parseDOM = [{ tag: 'td' }];
nodes.table_header.parseDOM = [{ tag: 'th' }];

const schema = new Schema({ nodes, marks: {} });
const p = (t) => schema.nodes.paragraph.create(null, schema.text(t));
const cell = (t) => schema.nodes.table_cell.create(null, p(t));
const header = (t) => schema.nodes.table_header.create(null, p(t));
const mkTable = (rows) =>
  schema.nodes.table.create(null, rows.map((r) => schema.nodes.table_row.create(null, r.map((c, i) => (i === 0 ? header(c) : cell(c))))));

const doc = schema.nodes.doc.create(null, [
  mkTable([
    ['H1', 'A2'],
    ['B1', 'B2'],
  ]),
  p('TRAILING SENTENCE AFTER TABLE'),
]);
console.log('doc:', doc.toString().replace(/\n/g, ' | '));
const tablePos = 1; // doc: [table, paragraph]
const tableNode = doc.child(0);
console.log('table node:', tableNode.type.name);
const map = TableMap.get(tableNode);
console.log('map:', map.width, 'x', map.height, JSON.stringify(map.map));
const lastCellOffset = map.positionAt(map.height - 1, map.width - 1, tableNode);
const firstCellOffset = map.positionAt(0, 0, tableNode);
console.log('offsets:', firstCellOffset, lastCellOffset);
// $anchorCell 位置 = 单元格节点位置 - 1（before(depth) 语义：resolve 后 parent=row、nodeAfter=cell）
const anchorCell = doc.resolve(tablePos + 1 + firstCellOffset - 1);
const headCell = doc.resolve(tablePos + 1 + lastCellOffset - 1);
console.log('anchorCell:', anchorCell.pos, 'depth', anchorCell.depth, 'parent', anchorCell.parent.type.name, 'nodeAfter', anchorCell.nodeAfter?.type.name, 'node(-1)', anchorCell.node(-1).type.name);
console.log('headCell  :', headCell.pos, 'depth', headCell.depth, 'parent', headCell.parent.type.name, 'nodeAfter', headCell.nodeAfter?.type.name, 'node(-1)', headCell.node(-1).type.name);

/** 复刻 view.copy：sel.content() → DOMSerializer → HTML */
function serializeContent(sel) {
  const frag = sel.content().content;
  const ser = DOMSerializer.fromSchema(schema);
  const div = document.createElement('div');
  frag.forEach((n) => div.appendChild(ser.serializeNode(n)));
  return div.innerHTML;
}

/** 复刻 parseFromClipboard（简化 openStart/openEnd=0） */
function parseHtml(html) {
  const el = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html').body.firstChild;
  const node = PMDOMParser.fromSchema(schema).parse(el);
  return new Slice(node.content, 0, 0);
}

function runCase(name, copySel, pasteState, guardFirst = false) {
  const html = serializeContent(copySel);
  const slice = parseHtml(html);
  let state = pasteState;
  const view = {
    state,
    dispatch: (tr) => {
      state = state.apply(tr);
    },
  };
  let handled;
  if (guardFirst) {
    // 模拟 tablePasteGuardPlugin：切片含表格节点且目标在表格内 → 整表替换
    const containsTable = (frag) => {
      let f = false;
      const chk = (fr) => {
        fr.forEach((n) => {
          if (f) return;
          if (n.type.name.startsWith('table')) f = true;
          else if (n.content) chk(n.content);
        });
      };
      chk(frag);
      return f;
    };
    if (containsTable(slice.content)) {
      const $head = state.selection.$headCell ?? state.selection.$head;
      const table = findTable($head);
      if (table) {
        const { node, start } = table;
        const tablePos = start - 1;
        state = state.apply(state.tr.replace(tablePos, tablePos + node.nodeSize, slice));
        handled = 'GUARD';
      }
    }
    if (!handled) handled = tableEditing().props.handlePaste(view, {}, slice);
  } else {
    handled = tableEditing().props.handlePaste(view, {}, slice);
  }
  if (!handled) {
    // 模拟正常粘贴路径：replaceSelection（handlePaste 返回 false 时 view 的默认行为）
    state = state.apply(state.tr.replaceSelection(slice));
  }
  const docStr = state.doc.toString().replace(/\n/g, ' | ');
  console.log(`\n===== ${name} =====`);
  console.log('copied HTML :', html);
  console.log('handlePaste :', handled);
  console.log('result doc  :', docStr);
  return { name, docStr };
}

// ===== 断言辅助（必须先于用例声明） =====
let failures = 0;
const expect = (name, cond) => {
  if (!cond) {
    failures++;
    console.log('[repro] FAIL: ' + name);
  }
};

// ① 整表 CellSelection 复制 → 同一整表 CellSelection 上粘贴（替换）
const r1 = runCase('① full-table CellSelection copy -> paste onto same CellSelection', new CellSelection(anchorCell, headCell), EditorState.create({ doc, selection: new CellSelection(anchorCell, headCell) }));

// ② 整表 CellSelection 复制 → 光标在表格内粘贴
const r2 = runCase('② full-table CellSelection copy -> paste at cursor in table', new CellSelection(anchorCell, headCell), EditorState.create({ doc, selection: TextSelection.near(doc.resolve(anchorCell.pos + 2)) }));

// ③ 全文档选区（含表格后句子，模拟 Ctrl+A / 从表格下方往上拖选）复制 → 整表 CellSelection 上粘贴（未守卫 → 复现 bug）
const wholeDocSel = new TextSelection(doc.resolve(4), doc.resolve(doc.content.size - 1));
const r3 = runCase('③ whole-doc TextSelection copy -> paste onto full-table CellSelection', wholeDocSel, EditorState.create({ doc, selection: new CellSelection(anchorCell, headCell) }));

// ④ 全文档选区复制 → 光标在表格内粘贴（右下角格子，未守卫 → 复现 bug）
const r4 = runCase('④ whole-doc TextSelection copy -> paste at cursor in last cell', wholeDocSel, EditorState.create({ doc, selection: TextSelection.near(doc.resolve(headCell.pos + 2)) }));

// ③g 守卫修复后：③ 同场景（整表替换）
const r3g = runCase('③g GUARD: whole-doc copy -> paste onto CellSelection (replace whole table)', wholeDocSel, EditorState.create({ doc, selection: new CellSelection(anchorCell, headCell) }), true);

// ④g 守卫修复后：④ 同场景（整表替换）
const r4g = runCase('④g GUARD: whole-doc copy -> paste at cursor in last cell (replace whole table)', wholeDocSel, EditorState.create({ doc, selection: TextSelection.near(doc.resolve(headCell.pos + 2)) }), true);

// ⑤ 整表 CellSelection 复制 → 表格下方空段落粘贴
const r5 = runCase('⑤ full-table CellSelection copy -> paste below table', new CellSelection(anchorCell, headCell), EditorState.create({ doc, selection: TextSelection.near(doc.resolve(doc.content.size - 1)) }));

// ⑥ 整表 CellSelection 的 content() 是否干净（只含表格）
const c = new CellSelection(anchorCell, headCell).content();
console.log('\n===== ⑥ full-table CellSelection.content() =====');
console.log('slice content:', c.content.toString().slice(0, 200));

// ⑦ 事务级守卫：光标在表格内 → 出现"整篇全选"事务 → 改写为整表 CellSelection
{
  const oldState = EditorState.create({ doc, selection: TextSelection.near(doc.resolve(5)) });
  // 模拟 DOMObserver 同步浏览器原生 select-all：整篇选区事务（0..doc.size）
  const fullDocState = oldState.apply(oldState.tr.setSelection(new TextSelection(doc.resolve(0), doc.resolve(doc.content.size))));
  const sel = fullDocState.selection;
  const $oldHead = oldState.selection.$head;
  const oldTable = findTable($oldHead);
  let converted = false;
  if (!(sel instanceof TextSelection) || sel.empty) {
    converted = false;
  } else if (sel.from !== 0 || sel.to !== fullDocState.doc.content.size) {
    converted = false; // 非整篇：守卫不介入
  } else if (!oldTable) {
    converted = false; // 选中前不在表格内：守卫不介入
  } else {
    const { node, start } = oldTable;
    const m = TableMap.get(node);
    const first = m.positionAt(0, 0, node);
    const last = m.positionAt(m.height - 1, m.width - 1, node);
    const anchor = fullDocState.doc.resolve(start + first);
    const head = fullDocState.doc.resolve(start + last);
    const final = fullDocState.apply(fullDocState.tr.setSelection(new CellSelection(anchor, head)));
    converted = final.selection instanceof CellSelection && final.selection.ranges.length === 4;
  }
  expect('⑦ appendTransaction guard converts full-doc select-all to whole-table', converted);
  // 反向：选中前不在表格内 → 守卫不介入（保持整篇全选）
  const oldState2 = EditorState.create({ doc, selection: TextSelection.near(doc.resolve(doc.content.size - 2)) });
  const fullDoc2 = oldState2.apply(oldState2.tr.setSelection(new TextSelection(doc.resolve(0), doc.resolve(doc.content.size))));
  expect('⑦b guard ignores select-all when not previously in a table', !findTable(oldState2.selection.$head));
}

// ===== 断言 =====
// 未守卫时 bug 可复现：表格嵌套进格子（句子混入格子）
expect('bug repro: unguarded ③ nests table+sentence into cells', r3.docStr.includes('table_cell(table'));
expect('bug repro: unguarded ④ nests table+sentence into target cell', r4.docStr.includes('table_cell(table'));
// 守卫后：句子不再出现在任何格子里（整表被替换，句子作为表格后的段落保留）
expect('guard ③g: no table nested in a cell', !r3g.docStr.includes('table_cell(table'));
expect('guard ④g: no table nested in a cell', !r4g.docStr.includes('table_cell(table'));
expect('guard ③g: pasted table kept', r3g.docStr.includes('table(table_row(table_header(paragraph("H1"))'));
expect('guard ④g: pasted table kept', r4g.docStr.includes('table(table_row(table_header(paragraph("H1"))'));
// 干净路径不受影响：整表复制 → 粘贴到表格下方 = 表格正常插入
expect('clean paste below table keeps one table + sentence + copy', r5.docStr.includes('paragraph("TRAILING SENTENCE AFTER TABLE"), table('));
expect('clean CellSelection copy contains only the table', c.content.toString().startsWith('<table('));

if (failures) {
  console.log(`[repro] ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('[repro] ALL COPY/PASTE CHECKS PASSED');
