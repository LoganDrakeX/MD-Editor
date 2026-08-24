/**
 * 列表交互修复验证（无头 Chrome + CDP）
 * 1) 单击列表文字 → 工具栏列表 icon 一次高亮（Bug1）
 * 2) 无序→有序 / 有序→无序 / 无序→任务 / 有序→任务 转换（Bug2）
 * 用法: node scripts/repro-list.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDataDir = mkdtempSync(path.join(tmpdir(), 'repro-chrome-'));
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

const realClick = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(200);
};

const state = () =>
  evalJs(`(() => {
    const btn = (t) => document.querySelector('.toolbar-btn[title=' + JSON.stringify(t) + ']');
    const msgs = window.__hostMsgs.filter((m) => m.type === 'content-changed');
    return {
      bullet: !!btn('无序列表')?.classList.contains('active'),
      ordered: !!btn('有序列表')?.classList.contains('active'),
      task: !!btn('任务列表')?.classList.contains('active'),
      lists: [...document.querySelectorAll('.milkdown .ProseMirror ul, .milkdown .ProseMirror ol')].map((e) => e.tagName).join(','),
      taskItems: document.querySelectorAll('.milkdown .ProseMirror li[data-item-type="task"]').length,
      md: msgs.length ? msgs[msgs.length - 1].content : null,
    };
  })()`);

const clickAtList = async (listIdx) => {
  const pt = await evalJs(`(() => {
    const lis = [...document.querySelectorAll('.milkdown .ProseMirror li')];
    const li = lis[${listIdx}];
    const p = li.querySelector('p') || li;
    const r = p.getBoundingClientRect();
    return { x: Math.round(r.left + 12), y: Math.round(r.top + r.height / 2) };
  })()`);
  await realClick(pt.x, pt.y);
};
const clickBtn = async (title) => {
  await evalJs(
    `document.querySelector('.toolbar-btn[title=' + JSON.stringify(${JSON.stringify(title)}) + ']')?.click()`
  );
  await sleep(900);
};

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  => ' + detail}`);
  if (!cond) failures++;
};

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: fileUrl });
  await waitFor(`document.readyState === 'complete' && document.querySelector('#root').childElementCount > 0`, 'React 挂载');
  await sleep(300);

  await evalJs(`window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'load',
    content: '# 标题\\n\\n- 甲\\n- 乙\\n\\n1. 一\\n2. 二',
    filePath: 'C:/docs/t.md',
    imageRoot: 'vscode-webview-resource://dummy/C:/docs/',
    settings: { defaultMode: 'wysiwyg', imageFolder: 'images', imageNameMode: 'timestamp',
      autoSaveDelay: 800, syncFromDisk: true, splitView: false, enableWikiLinks: true, theme: 'light' }
  } }))`);
  if (!(await waitFor(`!!document.querySelector('.milkdown .ProseMirror li')`, 'Milkdown 就绪'))) process.exit(1);
  await sleep(500);

  // ---- Bug1：单击列表文字一次 → icon 高亮 ----
  await clickAtList(0); // 无序列表 "甲"
  let s = await state();
  check('单击无序列表文字 → 无序 icon 高亮', s.bullet && !s.ordered, JSON.stringify(s));

  // ---- Bug2a：无序 → 有序 ----
  await clickBtn('有序列表');
  s = await state();
  check('无序→有序 转换生效（ul→ol）', s.lists.startsWith('OL') && s.md?.includes('1. 甲'), JSON.stringify(s));

  // ---- Bug2b：有序 → 无序（曾被 keep-list-order 回退）----
  await clickBtn('无序列表');
  s = await state();
  check('有序→无序 转换生效（ol→ul）', s.lists.startsWith('UL') && s.md?.includes('- 甲'), JSON.stringify(s));

  // ---- Bug2c：无序 → 任务 ----
  await clickBtn('任务列表');
  s = await state();
  check(
    '无序→任务 转换生效（含 [ ] 且 task 项渲染）',
    s.taskItems > 0 && s.md?.includes('[ ]'),
    JSON.stringify(s)
  );
  // ---- 修复1：任务列表下只亮"任务列表"icon，不亮"无序列表" ----
  check('任务列表下 任务 icon 高亮', s.task, JSON.stringify(s));
  check('任务列表下 无序 icon 不高亮', !s.bullet, JSON.stringify(s));

  // ---- 修复2：任务列表 → 无序列表（还原 checked）----
  await clickBtn('无序列表');
  s = await state();
  check(
    '任务→无序 转换生效（checked 还原，[ ] 消失）',
    s.taskItems === 0 && !s.md?.includes('[ ]') && s.bullet && !s.task,
    JSON.stringify(s)
  );

  // 转有序
  await clickBtn('有序列表');
  s = await state();

  // ---- Bug2d：有序 → 任务（应转为无序任务列表）----
  await clickBtn('任务列表');
  s = await state();
  check(
    '有序→任务 转换生效（ol→ul + 任务项）',
    s.taskItems > 0 && s.md?.includes('[ ]') && s.lists.startsWith('UL'),
    JSON.stringify(s)
  );

  console.log(failures === 0 ? '\n[repro] ALL CHECKS PASSED' : `\n[repro] ${failures} FAILED`);
} catch (err) {
  console.error('[repro] ERROR', err);
  failures = -1;
} finally {
  try { ws.close(); } catch {}
  chrome.kill();
  process.exit(failures === 0 ? 0 : 1);
}
