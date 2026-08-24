/**
 * 复现"打开即被重写"：WYSIWYG 模式下加载含 `-` 列表与 `|---|` 表格的 md，
 * 检查 webview 是否立即回传 content-changed（格式化被归一化）。
 * 用法: node scripts/repro-open.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDataDir = mkdtempSync(path.join(tmpdir(), 'repro-open-chrome-'));
const fileUrl = 'file:///' + path.resolve('scripts/repro-list.html').replace(/\\/g, '/');

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--disable-gpu',
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let target;
for (let i = 0; i < 150; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const list = await res.json();
    target = list.find((t) => t.type === 'page');
    if (target) break;
  } catch {}
  await sleep(100);
}
if (!target) {
  console.error('无法连接无头 Chrome');
  chrome.kill();
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error('CDP websocket failed'));
});

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error('page eval error: ' + JSON.stringify(r.result.exceptionDetails));
  }
  return r.result?.result?.value;
};
const waitFor = async (expr, label, tries = 150) => {
  for (let i = 0; i < tries; i++) {
    if (await evalJs(expr)) return true;
    await sleep(100);
  }
  console.error('等待超时: ' + label);
  return false;
};

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: fileUrl });
  await waitFor(`document.readyState === 'complete' && document.querySelector('#root').childElementCount > 0`, 'React 挂载');
  await sleep(300);

  // 与用户文件相同风格：`-` 列表 + `|---|` 表格
  const doc = [
    '# add_charts 参数扩展方案',
    '',
    '## 1. 变更概述',
    '',
    '- 删除 `requestId`。',
    '- 新增可选参数 `chartTitle`。',
    '',
    '| 图表类型 | 写入字段 | 空字符串行为 |',
    '| --- | --- | --- |',
    '| 普通图表 | `formatData.chartTitle.text` | 回退到 App 名称 |',
    '| Text | 忽略 | 返回 `null` |',
    '',
    '> 引用块保持原样。',
  ].join('\\n');

  await evalJs(`window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'load',
    content: '${doc}',
    filePath: 'C:/docs/add_charts参数扩展方案.md',
    imageRoot: 'vscode-webview-resource://dummy/C:/docs/',
    settings: { defaultMode: 'wysiwyg', imageFolder: 'images', imageNameMode: 'timestamp',
      autoSaveDelay: 800, syncFromDisk: true, splitView: false, enableWikiLinks: true, theme: 'light' }
  } }))`);
  await waitFor(`!!document.querySelector('.milkdown .ProseMirror li')`, '编辑器就绪');
  await sleep(1600); // 等 markdownUpdated(200ms) + content-changed(150ms) 防抖

  const msgs = await evalJs(`(() => {
    const m = window.__hostMsgs.filter((x) => x.type === 'content-changed');
    return m.map((x) => x.content);
  })()`);

  console.log('content-changed 消息数:', msgs.length);
  if (msgs.length) {
    console.log('--- 回传的内容 ---');
    console.log(msgs[msgs.length - 1]);
  } else {
    console.log('（无回传，打开未改写文件 ✓）');
  }

  // 真实编辑（真实鼠标点击标题段落 + 输入字符）→ 应触发保存，且序列化保持输入风格
  const pt = await evalJs(`(() => {
    const p = document.querySelector('.milkdown .ProseMirror p');
    const r = p.getBoundingClientRect();
    return { x: Math.round(r.left + 12), y: Math.round(r.top + r.height / 2) };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await sleep(250);
  await send('Input.insertText', { text: 'X' });
  await sleep(1000);

  const after = await evalJs(`(() => {
    const m = window.__hostMsgs.filter((x) => x.type === 'content-changed');
    return {
      md: m.length ? m[m.length - 1].content : null,
      docHasX: document.querySelector('.milkdown .ProseMirror')?.textContent?.includes('X') ?? false,
      allMsgs: window.__hostMsgs.map((x) => x.type),
      errs: window.__errs.slice(0, 10),
      dbg3: (window.__DBG3 || []).slice(0, 10),
      cfg: (window.__CFG || []).slice(0, 5),
    };
  })()`);
  console.log('\n编辑后: docHasX =', after.docHasX, '| 消息类型 =', JSON.stringify(after.allMsgs));
  console.log('页面错误:', JSON.stringify(after.errs, null, 1));
  console.log('markdownUpdated 调试:', JSON.stringify(after.dbg3, null, 1));
  console.log('配置生效调试:', JSON.stringify(after.cfg, null, 1));
  console.log('回传内容:', after.md || '（未回传！）');

  const ok =
    after.md &&
    after.md.includes('add_charts') &&
    !after.md.includes('add\\_charts') &&
    after.md.includes('- 删X除') &&
    !after.md.includes('* 删') &&
    after.md.includes('| 图表类型 | 写入字段 | 空字符串行为 |') &&
    after.md.includes('| --- | --- | --- |') &&
    !after.md.includes('| 图表类型 | 写入字段                      ') &&
    after.md.includes('X');
  console.log(ok ? '\n[repro-open] 编辑保持输入风格 + 正常保存 ✓' : '\n[repro-open] 校验失败 ✗');

  // 连续第二次编辑：确认保存链路不因首次保存/状态回环而中断
  await send('Input.insertText', { text: 'Y' });
  await sleep(1000);
  const after2 = await evalJs(`(() => {
    const m = window.__hostMsgs.filter((x) => x.type === 'content-changed');
    return { count: m.length, md: m.length ? m[m.length - 1].content : null };
  })()`);
  const ok2 = after2.count >= 2 && after2.md?.includes('Y');
  console.log(ok2 ? `[repro-open] 连续两次编辑均保存 ✓（${after2.count} 次 content-changed）` : `[repro-open] 连续编辑保存异常 ✗ ${JSON.stringify(after2)}`);

  // 场景2：非标准风格（`*` 列表 + 对齐表格，round-trip 有损）——打开仍不应改写
  await evalJs(`(() => { window.__hostMsgs.length = 0; return true; })()`);
  await evalJs(`window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'load',
    content: '# 标题\\n\\n* 甲\\n* 乙\\n\\n| 左 | 很长很长的单元格内容 |\\n| --- | --- |\\n| x | y |',
    filePath: 'C:/docs/t2.md',
    imageRoot: 'vscode-webview-resource://dummy/C:/docs/',
    settings: { defaultMode: 'wysiwyg', imageFolder: 'images', imageNameMode: 'timestamp',
      autoSaveDelay: 800, syncFromDisk: true, splitView: false, enableWikiLinks: true, theme: 'light' }
  } }))`);
  await sleep(1600);
  const msgs2 = await evalJs(`window.__hostMsgs.filter((x) => x.type === 'content-changed').length`);
  console.log(msgs2 === 0 ? '\n[repro-open] 非标准风格文件打开也不改写 ✓' : `\n[repro-open] 非标准风格文件打开被改写（${msgs2} 条）✗`);

  // 场景3：打开后立刻键入（不等加载归一化 markdownUpdated 落定）→ 首次键入也应保存
  await evalJs(`(() => { window.__hostMsgs.length = 0; return true; })()`);
  await evalJs(`window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'load',
    content: '# 快速编辑测试\\n\\n- 甲',
    filePath: 'C:/docs/t3.md',
    imageRoot: 'vscode-webview-resource://dummy/C:/docs/',
    settings: { defaultMode: 'wysiwyg', imageFolder: 'images', imageNameMode: 'timestamp',
      autoSaveDelay: 800, syncFromDisk: true, splitView: false, enableWikiLinks: true, theme: 'light' }
  } }))`);
  // 等编辑器就绪后立刻点击并键入（不等待 200ms 归一化防抖）
  await waitFor(`!!document.querySelector('.milkdown .ProseMirror li')`, '快速编辑就绪');
  const pt3 = await evalJs(`(() => {
    const p = document.querySelector('.milkdown .ProseMirror li p');
    const r = p.getBoundingClientRect();
    return { x: Math.round(r.left + 12), y: Math.round(r.top + r.height / 2) };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt3.x, y: pt3.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt3.x, y: pt3.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt3.x, y: pt3.y, button: 'left', clickCount: 1 });
  await send('Input.insertText', { text: 'Z' });
  await sleep(1200);
  const msgs3 = await evalJs(`(() => {
    const m = window.__hostMsgs.filter((x) => x.type === 'content-changed');
    return { count: m.length, md: m.length ? m[m.length - 1].content : null };
  })()`);
  console.log(
    msgs3.count >= 1 && msgs3.md?.includes('Z')
      ? `[repro-open] 打开后立刻键入仍保存 ✓ ${JSON.stringify(msgs3.md)}`
      : `[repro-open] 打开后立刻键入丢失 ✗ ${JSON.stringify(msgs3)}`
  );

  // 场景4：工具栏"保存"按钮 → 发出 save-request（内容 = WYSIWYG 实时序列化）
  await evalJs(`(() => { window.__hostMsgs.length = 0; return true; })()`);
  await evalJs(`document.querySelector('.toolbar-btn[title="保存"]')?.click()`);
  await sleep(400);
  const sr = await evalJs(`(() => {
    const m = window.__hostMsgs.filter((x) => x.type === 'save-request');
    return { count: m.length, md: m.length ? m[m.length - 1].content : null };
  })()`);
  console.log(
    sr.count >= 1 && sr.md?.includes('Z')
      ? `[repro-open] 保存按钮发出 save-request（含最新编辑）✓`
      : `[repro-open] 保存按钮 save-request 异常 ✗ ${JSON.stringify(sr)}`
  );
  // 表情按钮应已移除
  const emojiLeft = await evalJs(`!!document.querySelector('.toolbar-btn[title="插入表情"]')`);
  console.log(emojiLeft ? '[repro-open] 表情按钮仍存在 ✗' : '[repro-open] 表情按钮已移除 ✓');

  // 场景5：Ctrl+S（插件内）→ 同样发出 save-request
  await evalJs(`(() => { window.__hostMsgs.length = 0; return true; })()`);
  await evalJs(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(400);
  const cs = await evalJs(`(() => {
    const m = window.__hostMsgs.filter((x) => x.type === 'save-request');
    return { count: m.length, md: m.length ? m[m.length - 1].content : null };
  })()`);
  console.log(
    cs.count >= 1 && cs.md?.includes('Z')
      ? `[repro-open] Ctrl+S 触发 save-request ✓`
      : `[repro-open] Ctrl+S 未触发 save-request ✗ ${JSON.stringify(cs)}`
  );

  // 场景6：瞬时脏——重新加载干净文档后击键，立即（<120ms）出现 dirty=true，且先于 content-changed
  await evalJs(`(() => { window.__hostMsgs.length = 0; return true; })()`);
  await evalJs(`window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'load',
    content: '# 脏检测测试\\n\\n- 甲',
    filePath: 'C:/docs/t4.md',
    imageRoot: 'vscode-webview-resource://dummy/C:/docs/',
    settings: { defaultMode: 'wysiwyg', imageFolder: 'images', imageNameMode: 'timestamp',
      autoSaveDelay: 800, syncFromDisk: true, splitView: false, enableWikiLinks: true, theme: 'light' }
  } }))`);
  await waitFor(`!!document.querySelector('.milkdown .ProseMirror li')`, '脏检测就绪');
  await sleep(600);
  await evalJs(`(() => { window.__hostMsgs.length = 0; return true; })()`);
  await evalJs(`document.querySelector('.milkdown .ProseMirror')?.focus()`);
  const t0 = Date.now();
  await send('Input.insertText', { text: 'W' });
  await sleep(120); // 仅等 120ms：远小于原 markdownUpdated(200ms)+scheduleSave(800ms) 链路
  const dirtyEarly = await evalJs(`(() => {
    const msgs = window.__hostMsgs.slice();
    const dirtyIdx = msgs.findIndex((x) => x.type === 'dirty' && x.dirty === true);
    const ccIdx = msgs.findIndex((x) => x.type === 'content-changed');
    return {
      dirtyEarly: dirtyIdx >= 0,
      dirtyBeforeCC: dirtyIdx >= 0 && (ccIdx < 0 || dirtyIdx < ccIdx),
      msgs: msgs.map((x) => x.type),
    };
  })()`);
  console.log(
    dirtyEarly.dirtyEarly && dirtyEarly.dirtyBeforeCC
      ? `[repro-open] 击键 ~120ms 内即报脏（先于 content-changed）✓ ${JSON.stringify(dirtyEarly.msgs)}`
      : `[repro-open] 瞬时脏未生效 ✗ ${JSON.stringify(dirtyEarly)}`
  );

  // 场景7：同步到宿主文档的速度（期望 ~200-300ms，原为 ~1.1s）
  await waitFor(
    `window.__hostMsgs.some((x) => x.type === 'content-changed')`,
    'content-changed 到达',
    60
  );
  const syncMs = Date.now() - t0;
  console.log(
    syncMs <= 500
      ? `[repro-open] 改动同步到宿主约 ${syncMs}ms ✓`
      : `[repro-open] 同步仍偏慢（${syncMs}ms）✗`
  );

  // 场景8：撤销回基线 → 报净（dirty=false）；再次编辑 → 再报脏
  await evalJs(`(() => {
    const el = document.querySelector('.milkdown .ProseMirror');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(250);
  const undoState = await evalJs(`(() => {
    const m = window.__hostMsgs.filter((x) => x.type === 'dirty');
    return {
      lastDirty: m.length ? m[m.length - 1] : null,
      seq: m.map((x) => x.dirty),
      docText: document.querySelector('.milkdown .ProseMirror')?.textContent?.slice(0, 30) ?? '',
    };
  })()`);
  console.log('撤销后: docText =', JSON.stringify(undoState.docText), '| 脏序列 =', JSON.stringify(undoState.seq));
  await send('Input.insertText', { text: 'V' });
  await sleep(200);
  const afterReedit = await evalJs(`(() => {
    const m = window.__hostMsgs.filter((x) => x.type === 'dirty');
    return { seq: m.map((x) => x.dirty), last: m.length ? m[m.length - 1] : null };
  })()`);
  console.log(
    undoState.lastDirty?.dirty === false && afterReedit.last?.dirty === true
      ? `[repro-open] 撤销回基线报净、再次编辑报脏 ✓ ${JSON.stringify([undoState.seq, afterReedit.seq])}`
      : `[repro-open] 撤销脏状态异常 ✗ undo=${JSON.stringify(undoState)} reedit=${JSON.stringify(afterReedit)}`
  );

  // 场景9：外部变更同步进编辑器（双向同步 webview 侧）+ 不报脏
  await evalJs(`(() => { window.__hostMsgs.length = 0; return true; })()`);
  await evalJs(`window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'external-change',
    content: '# 外部改动\\n\\n- 乙',
  } }))`);
  await sleep(1200);
  const extState = await evalJs(`(() => {
    const msgs = window.__hostMsgs;
    return {
      dirtyMsgs: msgs.filter((x) => x.type === 'dirty').length,
      types: msgs.map((x) => x.type),
      editorText: document.querySelector('.milkdown .ProseMirror')?.textContent ?? '',
    };
  })()`);
  console.log(
    extState.dirtyMsgs === 0 && extState.editorText.includes('外部改动') && extState.editorText.includes('乙')
      ? `[repro-open] 外部变更同步进编辑器且不报脏 ✓ ${JSON.stringify(extState.types)}`
      : `[repro-open] 外部同步异常 ✗ ${JSON.stringify(extState)}`
  );

  // 场景10：模拟宿主"输入123又删回"的外部变更序列（webview 侧收敛，无残留字符）
  const seq = ['# 编辑同步测试\\n\\n- 删除 requestId1', '# 编辑同步测试\\n\\n- 删除 requestId12', '# 编辑同步测试\\n\\n- 删除 requestId123'];
  for (const c of seq) {
    await evalJs(`window.dispatchEvent(new MessageEvent('message', { data: { type: 'external-change', content: '${c}' } }))`);
    await sleep(60);
  }
  const backSeq = ['# 编辑同步测试\\n\\n- 删除 requestId12', '# 编辑同步测试\\n\\n- 删除 requestId1', '# 编辑同步测试\\n\\n- 删除 requestId'];
  for (const c of backSeq) {
    await evalJs(`window.dispatchEvent(new MessageEvent('message', { data: { type: 'external-change', content: '${c}' } }))`);
    await sleep(60);
  }
  await sleep(800);
  const conv = await evalJs(`(() => {
    const t = document.querySelector('.milkdown .ProseMirror')?.textContent ?? '';
    return { text: t, has1: t.includes('requestId1'), clean: t.includes('删除 requestId') && !/requestId1[23]?/.test(t) };
  })()`);
  console.log(
    conv.clean
      ? `[repro-open] 输入123又删回后编辑器无残留 ✓ ${JSON.stringify(conv.text)}`
      : `[repro-open] 编辑器残留旧字符 ✗ ${JSON.stringify(conv)}`
  );

  console.log('\n[repro-open] DONE');
} catch (err) {
  console.error('[repro-open] ERROR', err);
} finally {
  try { ws.close(); } catch {}
  chrome.kill();
  process.exit(0);
}
