/**
 * 任务项复选框验证（无头 Chrome + CDP）：
 * 1) WYSIWYG 中任务项渲染出 ::before 复选框（尺寸/位置与 CSS 常量一致）
 * 2) 点击复选框 → checked 切换（md 从 "* [ ] " ↔ "* [x] "），且光标不移入列表
 * 3) 预览模式 "[ ] / [x]" 渲染为只读复选框
 * 用法: node scripts/repro-task.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDataDir = mkdtempSync(path.join(tmpdir(), 'repro-task-chrome-'));
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
  await sleep(250);
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

  // 载入含任务项的文档
  await evalJs(`window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'load',
    content: '# 标题\\n\\n- [ ] 甲\\n- [x] 乙\\n\\n正文',
    filePath: 'C:/docs/t.md',
    imageRoot: 'vscode-webview-resource://dummy/C:/docs/',
    settings: { defaultMode: 'wysiwyg', imageFolder: 'images', imageNameMode: 'timestamp',
      autoSaveDelay: 800, syncFromDisk: true, splitView: false, enableWikiLinks: true, theme: 'light' }
  } }))`);
  if (!(await waitFor(`!!document.querySelector('.milkdown .ProseMirror li[data-item-type="task"]')`, '任务项就绪'))) process.exit(1);
  await sleep(600);

  // 1) 复选框渲染与位置
  const geom = await evalJs(`(() => {
    const li = document.querySelector('.milkdown .ProseMirror li[data-item-type="task"]');
    const r = li.getBoundingClientRect();
    const ps = getComputedStyle(li, '::before');
    const txt = li.querySelector('p').firstChild;
    const range = document.createRange();
    range.selectNodeContents(li.querySelector('p'));
    const line = range.getClientRects()[0] || r;
    return {
      li: { x: r.left, y: r.top, w: r.width, h: r.height },
      cbStyle: { left: ps.left, top: ps.top, w: ps.width, h: ps.height, display: ps.display, content: ps.content },
      textLine: { x: line.left, y: line.top, h: line.height },
      em: parseFloat(getComputedStyle(li).fontSize),
      checked: li.getAttribute('data-checked'),
    };
  })()`);
  console.log('几何:', JSON.stringify(geom, null, 1));
  const cb = geom.cbStyle;
  check('复选框已渲染（::before 有尺寸）', cb.w === '14px' && cb.h === '14px', JSON.stringify(cb));
  // 对齐：复选框中心 ≈ 首行文字中心（容差 4px）
  const cbCenterY = geom.li.y + 0.35 * geom.em + 7;
  const lineCenterY = geom.textLine.y + geom.textLine.h / 2;
  check(
    '复选框与首行文字垂直对齐（±4px）',
    Math.abs(cbCenterY - lineCenterY) <= 4,
    `cbCenter=${cbCenterY.toFixed(1)} lineCenter=${lineCenterY.toFixed(1)}`
  );

  // 2) 点击复选框 → 切换 checked，光标不移入
  // 复选框绝对位置 = li 左缘 + computed left（-1.8em + 0.4em）
  const cbLeft = await evalJs(`(() => {
    const li = document.querySelector('.milkdown .ProseMirror li[data-item-type="task"]');
    const ps = getComputedStyle(li, '::before');
    return li.getBoundingClientRect().left + parseFloat(ps.left);
  })()`);
  const cbX = cbLeft + 7;
  const cbY = geom.li.y + 0.35 * geom.em + 7;
  const before = await evalJs(`(() => {
    const msgs = window.__hostMsgs.filter((m) => m.type === 'content-changed');
    return { md: msgs.length ? msgs[msgs.length - 1].content : null, checked: document.querySelector('.milkdown .ProseMirror li[data-item-type="task"]').getAttribute('data-checked') };
  })()`);
  await realClick(cbX, cbY);
  await sleep(600);
  const after = await evalJs(`(() => {
    const msgs = window.__hostMsgs.filter((m) => m.type === 'content-changed');
    return {
      md: msgs.length ? msgs[msgs.length - 1].content : null,
      checked: document.querySelector('.milkdown .ProseMirror li[data-item-type="task"]').getAttribute('data-checked'),
      selInList: (() => {
        const s = window.getSelection();
        return !!(s && s.anchorNode && s.anchorNode.parentElement && s.anchorNode.parentElement.closest('li[data-item-type="task"]'));
      })(),
    };
  })()`);
  check(
    '点击复选框：md 变为 "- [x] 甲" 且 data-checked=true',
    after.checked === 'true' && after.md?.includes('- [x] 甲'),
    JSON.stringify(after)
  );
  check('点击复选框：光标未被移入列表', !after.selInList, JSON.stringify(after));
  console.log('  (before:', JSON.stringify(before), ')');

  // 再点一次 → 取消勾选
  await realClick(cbX, cbY);
  await sleep(600);
  const after2 = await evalJs(`(() => {
    const msgs = window.__hostMsgs.filter((m) => m.type === 'content-changed');
    return {
      md: msgs.length ? msgs[msgs.length - 1].content : null,
      checked: document.querySelector('.milkdown .ProseMirror li[data-item-type="task"]').getAttribute('data-checked'),
    };
  })()`);
  check('再次点击：取消勾选（- [ ] 甲）', after2.checked === 'false' && after2.md?.includes('- [ ] 甲'), JSON.stringify(after2));

  // 3) 点击复选框左侧文字 → 正常定位光标（不受复选框拦截影响）
  const txtX = geom.li.x + 30;
  const txtY = geom.textLine.y + geom.textLine.h / 2;
  await realClick(txtX, txtY);
  await sleep(200);
  const selInListAfter = await evalJs(`(() => {
    const s = window.getSelection();
    return !!(s && s.anchorNode && s.anchorNode.parentElement && s.anchorNode.parentElement.closest('li[data-item-type="task"]'));
  })()`);
  check('点击任务项文字 → 光标正常进入列表', selInListAfter, '');

  // 4) 预览模式渲染只读复选框
  await evalJs(`window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'settings-changed',
    settings: { defaultMode: 'preview', imageFolder: 'images', imageNameMode: 'timestamp',
      autoSaveDelay: 800, syncFromDisk: true, splitView: false, enableWikiLinks: true, theme: 'light' }
  } }))`);
  await evalJs(`(() => {
    const trig = document.querySelector('.toolbar .dropdown .toolbar-btn[title="切换模式"]');
    trig && trig.click();
    return true;
  })()`);
  await sleep(150);
  await evalJs(`(() => {
    const items = [...document.querySelectorAll('.dropdown-item')];
    const it = items.find((x) => x.textContent.includes('预览'));
    it && it.click();
    return true;
  })()`);
  await waitFor(`!!document.querySelector('.preview')`, '预览模式');
  await sleep(400);
  const prev = await evalJs(`(() => {
    const inputs = [...document.querySelectorAll('.preview li input[type="checkbox"].mdw-task-cb')];
    return { count: inputs.length, checked: inputs.filter((i) => i.checked).length };
  })()`);
  check('预览：任务项渲染出只读复选框（2 个，1 个勾选）', prev.count === 2 && prev.checked === 1, JSON.stringify(prev));

  console.log(failures === 0 ? '\n[repro-task] ALL CHECKS PASSED' : `\n[repro-task] ${failures} FAILED`);
} catch (err) {
  console.error('[repro-task] ERROR', err);
  failures = -1;
} finally {
  try { ws.close(); } catch {}
  chrome.kill();
  process.exit(failures === 0 ? 0 : 1);
}
