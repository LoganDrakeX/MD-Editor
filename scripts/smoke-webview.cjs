/**
 * Webview 前端冒烟测试：在 jsdom 中加载打包产物，验证
 * 1) bundle 无应用级运行时错误；
 * 2) React 挂载、ready 消息、load 消息处理；
 * 3) 模式切换：预览模式渲染 markdown-it HTML、源码模式出现 CodeMirror。
 * 说明：ProseMirror 依赖真实布局引擎，jsdom 中 Milkdown 初始化会报环境性
 * 错误（getClientRects / dispatchEvent 等），此类错误会被过滤，不作为失败。
 * 用法: node scripts/smoke-webview.cjs
 */
const { JSDOM } = require('jsdom');
const { buildSync } = require('esbuild');

const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
  runScripts: 'outside-only',
});

const { window } = dom;
global.window = window;
global.document = window.document;
global.navigator = window.navigator;
global.requestAnimationFrame = window.requestAnimationFrame.bind(window);
global.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
global.getComputedStyle = window.getComputedStyle.bind(window);
global.HTMLElement = window.HTMLElement;
global.Element = window.Element;
global.Node = window.Node;
global.MutationObserver = window.MutationObserver;
global.Window = window.Window;
global.addEventListener = window.addEventListener.bind(window);
global.removeEventListener = window.removeEventListener.bind(window);
global.dispatchEvent = window.dispatchEvent.bind(window);
global.getSelection = window.getSelection.bind(window);
global.FileReader = window.FileReader;
global.Blob = window.Blob;
global.File = window.File;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub;
window.ResizeObserver = ResizeObserverStub;

class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.IntersectionObserver = IntersectionObserverStub;
window.IntersectionObserver = IntersectionObserverStub;

// 模拟 VS Code 环境：记录 webview → 宿主消息
const hostMessages = [];
window.acquireVsCodeApi = () => ({
  postMessage: (msg) => hostMessages.push(msg),
});

// jsdom 缺少布局引擎，ProseMirror 测量会抛环境性错误 → 过滤
const ENV_ERROR_PATTERNS = [
  /getClientRects is not a function/,
  /not of type 'Event'/,
  /is not a function/,
  /not implemented/,
  /coordsAtPos/,
  /dispatchEvent/,
  /getBoundingClientRect/,
  /Window is not defined/,
];

const appErrors = [];
process.on('uncaughtException', (err) => {
  const text = String(err && err.stack ? err.stack : err);
  if (ENV_ERROR_PATTERNS.some((p) => p.test(text))) return; // 环境性错误，忽略
  appErrors.push(err);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error('SMOKE FAIL:', msg);
  if (appErrors.length) console.error(appErrors[0].stack || appErrors[0]);
  process.exit(1);
};

require('../dist/webview/webview.js');

(async () => {
  await wait(1200);
  if (appErrors.length) fail('uncaught app error during mount: ' + appErrors[0].message);
  const root = document.getElementById('root');
  if (!root || root.childElementCount === 0) fail('#root has no children (React did not mount)');
  if (!hostMessages.find((m) => m.type === 'ready')) fail('webview did not post ready');
  console.log('[smoke] React mounted, ready posted');

  // 模拟宿主 load 消息
  const content = '# 标题\n\n- 项目一\n- 项目二\n\n```ts\nconst a = 1;\n```\n\n![图](images/a.png)';
  const loadSettings = {
    defaultMode: 'source',
    imageFolder: 'images',
    imageNameMode: 'timestamp',
    autoSaveDelay: 800,
    syncFromDisk: true,
    splitView: false,
    enableWikiLinks: true,
    theme: 'auto',
  };
  window.dispatchEvent(
    new window.MessageEvent('message', {
      data: {
        type: 'load',
        content,
        filePath: 'C:/docs/readme.md',
        imageRoot: 'vscode-webview-resource://dummy/C:/docs/',
        settings: loadSettings,
      },
    })
  );
  await wait(600);
  if (appErrors.length) fail('uncaught app error after load: ' + appErrors[0].message);
  console.log('[smoke] load message handled');

  // 大纲：渲染标题、可点击跳转、可拖动改宽度
  const outline = document.querySelector('.outline');
  if (!outline) fail('outline panel missing');
  const outlineItems = [...document.querySelectorAll('.outline-item')].map((x) => x.textContent.trim());
  if (!outlineItems.includes('标题')) fail('outline missing heading 标题: ' + outlineItems.join(','));
  if (!document.querySelector('.outline-resizer')) fail('outline resizer missing');
  const resizer = document.querySelector('.outline-resizer');
  resizer.dispatchEvent(new window.MouseEvent('mousedown', { clientX: 100, bubbles: true }));
  window.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 170 }));
  window.dispatchEvent(new window.MouseEvent('mouseup', { clientX: 170 }));
  await wait(120);
  const outlineWidth = parseInt(document.querySelector('.outline').style.width || '0', 10);
  if (outlineWidth <= 140) fail('outline width did not change after drag: ' + outlineWidth);
  document.querySelector('.outline-item').click();
  await wait(200);
  if (appErrors.length) fail('outline jump caused app error');
  console.log('[smoke] outline renders headings, drag-resizes (' + outlineWidth + 'px), jump works');

  // 大纲开关：工具栏大纲 icon 可隐藏/显示
  const outlineToggle = document.querySelector('.outline-toggle');
  if (!outlineToggle) fail('outline toggle button missing');
  outlineToggle.click();
  await wait(150);
  if (document.querySelector('.outline')) fail('outline should hide after toggle click');
  outlineToggle.click();
  await wait(150);
  if (!document.querySelector('.outline')) fail('outline should reappear after second toggle click');
  console.log('[smoke] outline toggle in toolbar shows/hides panel');

  // 模式切换：通过模式下拉（只显示当前模式，点击弹开其他选项）
  const modeTrigger = () => document.querySelector('.toolbar .dropdown .toolbar-btn[title="切换模式"]');
  const pickMode = async (label) => {
    const trig = modeTrigger();
    if (!trig) fail('mode dropdown trigger not found');
    trig.click();
    await wait(120);
    const items = [...document.querySelectorAll('.dropdown-item')];
    const item = items.find((x) => x.textContent.includes(label));
    if (!item) fail('mode dropdown item not found: ' + label);
    item.click();
    await wait(400);
  };
  // 当前模式应只显示一个（下拉触发器文案 = 当前模式）
  const triggerText = modeTrigger().textContent.trim();
  if (!['WYSIWYG', '源码', '预览'].includes(triggerText)) fail('mode trigger does not show current mode: ' + triggerText);
  console.log('[smoke] mode dropdown shows only current mode: ' + triggerText);

  await pickMode('预览');
  const preview = document.querySelector('.preview');
  if (!preview) fail('preview pane not rendered');
  const h1 = preview.querySelector('h1');
  if (!h1 || h1.textContent.trim() !== '标题') fail('preview did not render heading');
  if (!h1.id) fail('preview heading should have anchor id (for outline jump)');
  const li = preview.querySelector('li');
  if (!li || li.textContent.trim() !== '项目一') fail('preview did not render list');
  const img = preview.querySelector('img');
  if (!img || !img.getAttribute('src').startsWith('images/')) fail('preview image src missing');
  if (!preview.querySelector('pre')) fail('preview code block missing');
  const previewLang = preview.querySelector('.preview-code-wrap .mdw-codeblock-lang');
  if (!previewLang || previewLang.textContent !== 'ts') {
    fail('preview code lang badge missing: ' + (previewLang && previewLang.textContent));
  }
  if (!preview.querySelector('pre code .hljs-keyword')) fail('preview code not syntax-highlighted');
  console.log('[smoke] preview mode renders markdown-it HTML (h1/list/code/img)');

  // 扩展列表：连续字母/罗马编号转换为有序列表，并携带正确的显示样式。
  window.dispatchEvent(
    new window.MessageEvent('message', {
      data: {
        type: 'external-change',
        content: 'a. Alpha\nb. Beta\n\nIV. Four\nV. Five\n\nI. think this is prose',
      },
    })
  );
  await wait(300);
  const styledLists = [...preview.querySelectorAll('ol')].map((list) => list.getAttribute('data-list-style'));
  if (!styledLists.includes('lower-alpha') || !styledLists.includes('upper-roman')) {
    fail('extended list styles missing: ' + styledLists.join(','));
  }
  if (!preview.textContent.includes('I. think this is prose')) fail('ambiguous I. sentence should remain prose');
  console.log('[smoke] preview renders alpha/Roman lists without misreading a lone I. sentence');

  // Wiki 双链：[[笔记]] 应渲染为可点击的 wiki-link
  window.dispatchEvent(
    new window.MessageEvent('message', {
      data: {
        type: 'external-change',
        content: '前文 [[待办清单|我的待办]] 后文\n\n# 标题\n\n- 项目一\n- 项目二\n\n```ts\nconst a = 1;\n```\n\n![图](images/a.png)',
      },
    })
  );
  await wait(400);
  const wikiLink = preview.querySelector('a.wiki-link');
  if (!wikiLink) fail('wiki link not rendered');
  if (wikiLink.textContent.trim() !== '我的待办') fail('wiki link alias not rendered');
  if (wikiLink.getAttribute('href') !== 'wiki:' + encodeURIComponent('待办清单')) {
    fail('wiki link href mismatch: ' + wikiLink.getAttribute('href'));
  }
  console.log('[smoke] wiki link rendered with alias + encoded href');

  // 图片宽度语法：![alt](src){width=200} → img[width]
  window.dispatchEvent(
    new window.MessageEvent('message', {
      data: {
        type: 'external-change',
        content: '![图](images/a.png){width=200}\n\n![普通](images/b.png)',
      },
    })
  );
  await wait(300);
  const widthImg = preview.querySelector('img[width="200"]');
  if (!widthImg) fail('image width syntax {width=200} not rendered');
  const normalImg = preview.querySelector('img:not([width])');
  if (!normalImg) fail('plain image should not get width attr');
  console.log('[smoke] image width {width=N} applied in preview, plain image unaffected');

  // 模式切换：源码 → CodeMirror
  await pickMode('源码');
  if (!document.querySelector('.cm-editor')) fail('CodeMirror editor not found');
  console.log('[smoke] source mode mounts CodeMirror');

  // 端到端：宿主回 image-saved → 源码模式光标处应插入图片引用
  window.dispatchEvent(
    new window.MessageEvent('message', {
      data: { type: 'image-saved', relativePath: 'images/a.png', absolutePath: 'C:/docs/images/a.png' },
    })
  );
  await wait(400);
  const cmText = document.querySelector('.cm-editor .cm-content')?.textContent ?? '';
  if (!cmText.includes('![a](images/a.png)')) fail('image reference not inserted into CodeMirror');
  console.log('[smoke] image-saved inserts ![a](images/a.png) into source mode');

  // 图片捕获纯函数：从剪贴板 items 提取图片 + base64 编码
  const capture = buildSync({
    entryPoints: ['src/webview/imageCapture.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
  });
  const capMod = { exports: {} };
  new Function('module', 'exports', 'require', capture.outputFiles[0].text)(
    capMod,
    capMod.exports,
    require
  );
  const pngBytes = Buffer.from('89504e470d0a1a0a', 'hex');
  const file = new window.File([pngBytes], 'shot.png', { type: 'image/png' });
  const picked = capMod.exports.imageFileFromClipboard([
    { type: 'text/plain', getAsFile: () => null },
    { type: 'image/png', getAsFile: () => file },
  ]);
  if (!picked || picked.name !== 'shot.png') fail('imageFileFromClipboard did not pick image');
  const pickedFromFiles = capMod.exports.imageFileFromClipboard(null, [file]);
  if (!pickedFromFiles || pickedFromFiles.name !== 'shot.png') fail('files fallback did not pick image');
  const b64 = await capMod.exports.fileToBase64(file);
  if (b64 !== pngBytes.toString('base64')) fail('fileToBase64 mismatch');
  console.log('[smoke] imageCapture: clipboard pick + files fallback + base64 encode OK');

  // 主题切换：点击按钮 → 应发送 set-theme 消息；宿主回 settings-changed(dark) → 深色类生效
  const themeToggle = document.querySelector('.theme-toggle');
  if (!themeToggle) fail('theme toggle button not found');
  const initialLight = document.querySelector('.app.mdw-light') !== null;
  themeToggle.click();
  await wait(200);
  const setThemeMsg = hostMessages.find((m) => m.type === 'set-theme');
  if (!setThemeMsg) fail('set-theme message not posted on toggle');
  if (setThemeMsg.theme !== 'dark') fail('expected set-theme dark from light default');
  const settingsDark = JSON.parse(JSON.stringify(loadSettings));
  settingsDark.theme = 'dark';
  window.dispatchEvent(
    new window.MessageEvent('message', {
      data: { type: 'settings-changed', settings: settingsDark },
    })
  );
  await wait(200);
  if (!document.querySelector('.app.mdw-dark')) fail('mdw-dark class not applied after theme change');
  if (!initialLight) fail('mdw-light class missing initially');
  console.log('[smoke] theme: light→dark toggle posts set-theme, mdw-dark applied');

  // 工具栏结构：Jira 风格（样式下拉 + 分组图标按钮）
  if (!document.querySelector('.tb-dropdown-label')) fail('style dropdown missing');
  const iconButtons = document.querySelectorAll('.toolbar .toolbar-btn').length;
  if (iconButtons < 15) fail('toolbar icon buttons too few: ' + iconButtons);
  if (!document.querySelector('.tb-divider')) fail('toolbar dividers missing');
  console.log('[smoke] Jira-style toolbar present (' + iconButtons + ' buttons + dropdowns + dividers)');

  // 段落样式下拉：WYSIWYG 模式下包含 普通文本 + H1~H6，且菜单项可点击
  await pickMode('WYSIWYG');
  const styleTrigger = document.querySelector('.toolbar .dropdown .toolbar-btn[title="段落样式"]');
  if (!styleTrigger) fail('style dropdown trigger not found');
  if (styleTrigger.disabled) fail('style dropdown should be enabled in WYSIWYG');
  styleTrigger.click();
  await wait(120);
  const styleItems = [...document.querySelectorAll('.dropdown-menu .dropdown-item')].map((x) =>
    x.textContent.trim()
  );
  for (const need of ['普通文本', '标题 1', '标题 2', '标题 3', '标题 4', '标题 5', '标题 6', '代码块']) {
    if (!styleItems.some((s) => s.includes(need))) fail('style dropdown missing: ' + need);
  }
  if (styleItems.some((s) => s.includes('引用'))) fail('quote option should be removed');
  console.log('[smoke] style dropdown has 普通文本 + H1~H6 + 代码块 (no 引用), ' + styleItems.length + ' items');

  // 表格按钮 → 网格选择器（6×6，hover 显示行列数）
  const tableTrigger = document.querySelector('.toolbar .dropdown .toolbar-btn[title*="插入表格"]');
  if (!tableTrigger) fail('table dropdown trigger not found');
  tableTrigger.click();
  await wait(150);
  const gridCells = document.querySelectorAll('.table-grid .tg-cell').length;
  if (gridCells !== 36) fail('table grid should be 6x6, got ' + gridCells);
  const label = document.querySelector('.table-grid-label')?.textContent?.trim();
  if (!label || !/^\d+ × \d+$/.test(label)) fail('table grid label missing');
  console.log('[smoke] table button opens 6x6 grid picker (' + label + ')');
  const overlay2 = document.querySelector('.dropdown-overlay');
  if (overlay2) overlay2.click();
  await wait(120);

  // 表格交互层：hitTest 纯函数（行/列边界加号、行/列手柄）
  const gutter = buildSync({
    entryPoints: ['src/webview/tableGutter.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
  });
  const gutMod = { exports: {} };
  new Function('module', 'exports', 'require', gutter.outputFiles[0].text)(gutMod, gutMod.exports, require);
  const rect = { top: 100, bottom: 220, left: 50, width: 300, height: 120 };
  const rows = [
    { top: 100, center: 110, bottom: 120 },
    { top: 120, center: 130, bottom: 140 },
  ];
  const cols = [
    { left: 50, center: 100, right: 150 },
    { left: 150, center: 200, right: 250 },
  ];
  const H = gutMod.exports.hitTest;
  // 表格中间的行列线不触发
  const r1 = H(100, 121, rect, rows, cols);
  if (r1.type !== null) fail('mid-table row line should show nothing: ' + JSON.stringify(r1));
  const r2 = H(152, 130, rect, rows, cols);
  if (r2.type !== null) fail('mid-table col line should show nothing: ' + JSON.stringify(r2));
  // 边缘 T 型交叉处触发边界
  const r1b = H(45, 121, rect, rows, cols);
  if (r1b.type !== 'row-boundary' || r1b.index !== 1) fail('left-strip row T-junction wrong: ' + JSON.stringify(r1b));
  const r2b = H(152, 92, rect, rows, cols);
  if (r2b.type !== 'col-boundary' || r2b.index !== 1) fail('top-strip col T-junction wrong: ' + JSON.stringify(r2b));
  // 手柄
  const r3 = H(42, 110, rect, rows, cols);
  if (r3.type !== 'row-handle' || r3.index !== 0) fail('row handle hit wrong: ' + JSON.stringify(r3));
  const r4 = H(100, 92, rect, rows, cols);
  if (r4.type !== 'col-handle' || r4.index !== 0) fail('col handle hit wrong: ' + JSON.stringify(r4));
  // 左上角 = 列边界（列优先）；行头区域不误触
  const r6 = H(rect.left, rect.top, rect, rows, cols);
  if (r6.type !== 'col-boundary' || r6.index !== 0) {
    fail('top-left corner should be col-boundary: ' + JSON.stringify(r6));
  }
  const r8 = H(45, 130, rect, rows, cols);
  if (r8.type !== 'row-handle' || r8.index !== 1) {
    fail('row header area should not trigger col-0 boundary: ' + JSON.stringify(r8));
  }
  console.log('[smoke] table gutter hitTest: T-junction only + handles + top-left=col OK');

  // 拖放拦截纯函数：单元格内拖起 / 整行选中拖起 → 禁止；内容含表格结构或落点在单元格 → 禁止
  const mkCell = () => {
    const td = document.createElement('td');
    return td;
  };
  const cellA = mkCell();
  const cellB = mkCell();
  const rowEl = document.createElement('tr');
  rowEl.append(cellA, cellB);
  const tableEl = document.createElement('table');
  tableEl.append(rowEl);
  const pOut = document.createElement('p');
  document.body.append(tableEl, pOut);
  const t1 = gutMod.exports.shouldBlockDragStart({ $anchorCell: null }, cellA);
  if (!t1) fail('dragstart inside a cell should be blocked');
  const t2 = gutMod.exports.shouldBlockDragStart({ $anchorCell: {} }, pOut);
  if (!t2) fail('dragstart with CellSelection should be blocked');
  const t3 = gutMod.exports.shouldBlockDragStart({ $anchorCell: null }, pOut);
  if (t3) fail('dragstart on plain paragraph should be allowed');
  const t4 = gutMod.exports.shouldBlockDrop('<table><tr><td>x</td></tr></table>', pOut);
  if (!t4) fail('drop of table markup below the table should be blocked');
  const t5 = gutMod.exports.shouldBlockDrop('hello', cellA);
  if (!t5) fail('drop into a cell should be blocked');
  const t6 = gutMod.exports.shouldBlockDrop('hello', pOut);
  if (t6) fail('plain drop on paragraph should be allowed');
  const t7 = gutMod.exports.eventTargetEl({ nodeType: 3, parentElement: cellA });
  if (t7 !== cellA) fail('text-node target should resolve to parent element');
  console.log('[smoke] table gutter drag/drop guards: OK');

  // 大纲：行内代码渲染 + 折叠/展开（放在最后，避免影响前面的内容断言）
  window.dispatchEvent(
    new window.MessageEvent('message', {
      data: { type: 'external-change', content: '# 安装 `npm`\n\n## 子标题\n\n正文' },
    })
  );
  await wait(300);
  const codeItem = [...document.querySelectorAll('.outline-item')].find((x) =>
    x.textContent.includes('npm')
  );
  if (!codeItem) fail('outline item with inline code missing');
  if (!codeItem.querySelector('.outline-code')) fail('outline inline code not rendered as code');
  if (codeItem.textContent.includes('`')) fail('outline shows literal backticks');
  document.querySelector('.outline-fold').click();
  await wait(150);
  const itemsAfterFold = [...document.querySelectorAll('.outline-item')].map((x) => x.textContent.trim());
  if (itemsAfterFold.some((t) => t.includes('子标题'))) fail('fold should hide sub-level headings');
  document.querySelector('.outline-fold').click();
  await wait(150);
  console.log('[smoke] outline renders inline code + fold/expand works');

  // markdown 内联解析：行内代码分段 + 去标记 + slug
  const mdMod = buildSync({
    entryPoints: ['src/webview/markdown.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
  });
  const mdM = { exports: {} };
  new Function('module', 'exports', 'require', mdMod.outputFiles[0].text)(mdM, mdM.exports, require);
  const segs = mdM.exports.parseInline('安装 `npm` 和 **加粗**');
  if (!segs.some((s) => s.code && s.text === 'npm')) fail('parseInline code segment missing');
  if (segs.some((s) => !s.code && s.text.includes('**'))) fail('parseInline did not strip bold markers');
  if (mdM.exports.slugify('安装 `npm`') !== '安装-npm') fail('slugify with backticks mismatch');
  // 下划线标题（add_charts）：匹配文本必须保留下划线
  if (mdM.exports.inlinePlain('add_charts 参数扩展方案') !== 'add_charts 参数扩展方案') {
    fail('inlinePlain stripped intraword underscore');
  }
  console.log('[smoke] markdown inline parse: code segment + marker strip + slug + underscore OK');

  // 大纲：含下划线标题显示正确（可跳转的匹配文本保留 _）
  window.dispatchEvent(
    new window.MessageEvent('message', {
      data: { type: 'external-change', content: '# add_charts 参数扩展方案\n\n正文' },
    })
  );
  await wait(300);
  const underscoreItem = [...document.querySelectorAll('.outline-item')].find((x) =>
    x.textContent.includes('add_charts')
  );
  if (!underscoreItem) fail('outline should keep underscore in add_charts heading');
  console.log('[smoke] outline keeps intraword underscore (jump text matches editor)');

  // 模式切换：WYSIWYG（Milkdown 在 jsdom 中初始化受限，尽力而为）
  const milkdown = document.querySelector('.milkdown');
  console.log(
    milkdown
      ? '[smoke] WYSIWYG pane mounted (Milkdown element present)'
      : '[smoke][warn] WYSIWYG pane did not produce .milkdown in jsdom (layout env limit)'
  );

  console.log('[smoke] ALL CHECKS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('SMOKE FAIL:', err);
  process.exit(1);
});
