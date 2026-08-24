/**
 * 三种列表（无序/有序/任务）行距与缩进一致性验证 + 任务复选框回归。
 * 用法: node scripts/repro-lists.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDataDir = mkdtempSync(path.join(tmpdir(), 'repro-lists-chrome-'));
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
    content: '# 标题\\n\\n- 甲\\n- 乙\\n\\n1. 甲\\n2. 乙\\n\\n- [ ] 甲\\n- [ ] 乙',
    filePath: 'C:/docs/t.md',
    imageRoot: 'vscode-webview-resource://dummy/C:/docs/',
    settings: { defaultMode: 'wysiwyg', imageFolder: 'images', imageNameMode: 'timestamp',
      autoSaveDelay: 800, syncFromDisk: true, splitView: false, enableWikiLinks: true, theme: 'light' }
  } }))`);
  if (!(await waitFor(`document.querySelectorAll('.milkdown .ProseMirror li').length >= 6`, '列表就绪'))) process.exit(1);
  await sleep(500);

  const m = await evalJs(`(() => {
    const lis = [...document.querySelectorAll('.milkdown .ProseMirror li')];
    const measure = (li) => {
      const p = li.querySelector('p');
      const r0 = p.getBoundingClientRect();
      const txt = p.firstChild;
      const range = document.createRange();
      range.selectNodeContents(txt);
      const line = range.getClientRects()[0] || r0;
      return { x: line.left, top: line.top, h: line.height, liTop: li.getBoundingClientRect().top };
    };
    // 0,1 = 无序；2,3 = 有序；4,5 = 任务
    const ul0 = measure(lis[0]), ul1 = measure(lis[1]);
    const ol0 = measure(lis[2]), ol1 = measure(lis[3]);
    const task0 = measure(lis[4]), task1 = measure(lis[5]);
    const cb = (() => {
      const li = lis[4];
      const ps = getComputedStyle(li, '::before');
      const liR = li.getBoundingClientRect();
      // 复选框绝对位置 = li 左缘 + computed left
      const left = liR.left + parseFloat(ps.left);
      return { w: ps.width, h: ps.height, top: ps.top, left: ps.left, absX: left };
    })();
    const align = (() => {
      // 复选框中心（liTop + 0.35em + 7）vs 任务项首行文字中心
      const liTop = lis[4].getBoundingClientRect().top;
      const cbCenter = liTop + 0.35 * 14 + 7;
      const lineCenter = task0.top + task0.h / 2;
      return Math.abs(cbCenter - lineCenter);
    })();
    return {
      indent: { ul: ul0.x, ol: ol0.x, task: task0.x },
      spacing: { ul: ul1.top - ul0.top, ol: ol1.top - ol0.top, task: task1.top - task0.top },
      lineH: { ul: ul0.h, ol: ol0.h, task: task0.h },
      cb,
      align,
    };
  })()`);
  console.log('测量:', JSON.stringify(m, null, 1));

  const close = (a, b) => Math.abs(a - b) < 1;
  check('缩进一致（无序=有序=任务）', close(m.indent.ul, m.indent.ol) && close(m.indent.ol, m.indent.task), JSON.stringify(m.indent));
  check('行距一致（无序=有序=任务）', close(m.spacing.ul, m.spacing.ol) && close(m.spacing.ol, m.spacing.task), JSON.stringify(m.spacing));
  check('复选框仍渲染（14×14）', m.cb.w === '14px' && m.cb.h === '14px', JSON.stringify(m.cb));
  check('复选框与任务首行对齐（±4px）', m.align <= 4, 'align=' + m.align.toFixed(1));
  // 复选框不遮字：复选框右缘 < 文字起点；且复选框落在 li 左侧的标记区内
  check(
    '复选框不遮住首字（右缘 < 文字起点）',
    m.cb.absX + 14 <= m.indent.task - 1,
    `cb右=${(m.cb.absX + 14).toFixed(1)} 文字=${m.indent.task.toFixed(1)}`
  );
  check(
    '复选框位于标记区（li 左缘 -1.8em ~ 0 之间）',
    m.cb.absX >= m.indent.task - 1.8 * 14 - 1 && m.cb.absX <= m.indent.task,
    'cbX=' + m.cb.absX.toFixed(1)
  );

  console.log(failures === 0 ? '\n[repro-lists] ALL CHECKS PASSED' : `\n[repro-lists] ${failures} FAILED`);
} catch (err) {
  console.error('[repro-lists] ERROR', err);
  failures = -1;
} finally {
  try { ws.close(); } catch {}
  chrome.kill();
  process.exit(failures === 0 ? 0 : 1);
}
