import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { saveImage } from './imageHandler';
import type { HostToWebviewMessage, WebviewToHostMessage } from './messages';
import { readSettings } from './settings';

export const VIEW_TYPE = 'md-editor.editor';

interface PanelState {
  context: vscode.ExtensionContext;
  document: vscode.TextDocument;
  panel: vscode.WebviewPanel;
  /** 上一次已知的、webview 持有的内容（用于去重/回环防护）。 */
  lastSent: string;
  saveTimer?: NodeJS.Timeout;
  disposables: vscode.Disposable[];
}

/** VS Code 可为同一 TextDocument 创建多个编辑器实例。 */
const panels = new Set<PanelState>();

/** 文本型自定义编辑器：由 VS Code 管理标签标题、脏状态、保存与恢复。 */
export class MDEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: localRoots(this.context, document.uri),
    };
    panel.iconPath = new vscode.ThemeIcon('markdown');

    const state: PanelState = {
      context: this.context,
      document,
      panel,
      lastSent: '',
      disposables: [],
    };
    panels.add(state);
    attach(panel, state);
    panel.onDidDispose(() => disposeState(state), undefined, state.disposables);
  }
}

/** 把消息处理、初始 HTML 挂到面板上（创建与反序列化复用）。 */
function attach(panel: vscode.WebviewPanel, state: PanelState): void {
  panel.webview.html = getHtml(panel.webview, state.context.extensionUri);

  // VS Code 内编辑同一文档 → onDidChangeTextDocument（handleDocumentChanged）同步；
  // 外部程序/工具直接改盘不由本插件负责（用户明确不需要该机制）。
  panel.webview.onDidReceiveMessage(
    (raw: WebviewToHostMessage) => {
      switch (raw.type) {
        case 'ready':
          sendLoad(state);
          break;
        case 'content-changed':
          scheduleSave(state, raw.content);
          break;
        case 'save-request':
          // 工具栏"保存"按钮 = Ctrl+S 语义：立即应用内容并显式写盘
          void applyContent(state, raw.content, true).catch((err) => {
            console.error('[md-editor] save-request error', err);
          });
          break;
        case 'save-image':
          void handleSaveImage(state, raw).catch((err) => {
            // handleSaveImage 内部已捕获并通知 webview
            console.error('[md-editor] save-image unexpected error', err);
          });
          break;
        case 'open-wiki':
          void handleOpenWiki(state, raw.name).catch((err) => {
            console.error('[md-editor] open-wiki error', err);
          });
          break;
        case 'open-external':
          void handleOpenExternal(raw.href).catch((err) => {
            console.error('[md-editor] open-external error', err);
          });
          break;
        case 'set-theme':
          void handleSetTheme(state, raw.theme).catch((err) => {
            console.error('[md-editor] set-theme error', err);
          });
          break;
        case 'log':
          console.log('[md-editor webview]', raw.text);
          break;
      }
    },
    undefined,
    state.disposables
  );
}

/** 只允许通过修饰键打开明确的外部链接，避免 Webview 直接导航或执行不安全协议。 */
async function handleOpenExternal(href: string): Promise<void> {
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(href);
  } catch {
    return;
  }
  const scheme = uri.scheme.toLowerCase();
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto') return;
  await vscode.env.openExternal(uri);
}

/** 处理 webview 的保存图片请求：写入磁盘并回传相对路径。 */
async function handleSaveImage(
  state: PanelState,
  msg: Extract<WebviewToHostMessage, { type: 'save-image' }>
): Promise<void> {
  try {
    const { relativePath, absolutePath } = await saveImage(state.document.uri, msg);
    const reply: HostToWebviewMessage = { type: 'image-saved', relativePath, absolutePath };
    void state.panel.webview.postMessage(reply);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`MD-Editor: 保存图片失败 - ${message}`);
    const reply: HostToWebviewMessage = { type: 'image-save-error', message };
    void state.panel.webview.postMessage(reply);
  }
}

/** 打开 [[wiki 链接]] 指向的 md 文件：同目录优先，其次工作区搜索，未找到则询问创建。 */
async function handleOpenWiki(state: PanelState, name: string): Promise<void> {
  if (state.document.uri.scheme !== 'file') return;
  const mdDir = path.dirname(state.document.uri.fsPath);
  const local = path.join(mdDir, `${name}.md`);
  if (fs.existsSync(local)) {
    await openFile(vscode.Uri.file(local));
    return;
  }
  // 工作区搜索同名文件
  const escaped = name.replace(/([\\[\]*?{}])/g, '\\$1');
  const found = await vscode.workspace.findFiles(`**/${escaped}.md`, '**/node_modules/**', 5);
  if (found.length > 0) {
    await openFile(found[0]);
    return;
  }
  const pick = await vscode.window.showQuickPick(['创建新文件', '取消'], {
    placeHolder: `未找到 "${name}.md"，是否在 ${mdDir} 下创建？`,
  });
  if (pick === '创建新文件') {
    const uri = vscode.Uri.file(local);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(`# ${name}\n\n`, 'utf-8'));
    await openFile(uri);
  }
}

async function openFile(uri: vscode.Uri): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
}

/** 用户点击工具栏主题按钮：写入用户级配置并广播给所有面板。 */
async function handleSetTheme(state: PanelState, theme: 'auto' | 'light' | 'dark'): Promise<void> {
  await vscode.workspace
    .getConfiguration('mdEditor')
    .update('theme', theme, vscode.ConfigurationTarget.Global);
  broadcastSettingsChanged();
}

/** 把最新设置广播给所有已打开的面板。 */
export function broadcastSettingsChanged(): void {
  const settings = readSettings();
  for (const s of panels) {
    const msg: HostToWebviewMessage = { type: 'settings-changed', settings };
    void s.panel.webview.postMessage(msg);
  }
}

/** 前置任意一个已打开的面板（用于打开 Webview 开发者工具）。 */
export function revealAnyPanel(): boolean {
  const first = panels.values().next().value as PanelState | undefined;
  if (!first) return false;
  first.panel.reveal();
  return true;
}

function sendLoad(state: PanelState): void {
  const content = currentDocumentText(state);
  state.lastSent = content;
  const msg: HostToWebviewMessage = {
    type: 'load',
    content,
    filePath: state.document.uri.fsPath,
    imageRoot: computeImageRoot(state.panel.webview, state.document.uri),
    settings: readSettings(),
  };
  void state.panel.webview.postMessage(msg);
}

/** 计算 md 所在目录的 webview 资源根（带尾斜杠），供相对图片路径解析。 */
function computeImageRoot(webview: vscode.Webview, documentUri: vscode.Uri): string {
  if (documentUri.scheme !== 'file') return '';
  const dir = vscode.Uri.file(path.dirname(documentUri.fsPath));
  const uri = webview.asWebviewUri(dir).toString();
  return uri.endsWith('/') ? uri : uri + '/';
}

/** md 所在目录作为 webview 资源根之一，允许加载本地图片。 */
function localRoots(context: vscode.ExtensionContext, documentUri: vscode.Uri): vscode.Uri[] {
  const roots = [
    vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'),
    vscode.Uri.joinPath(context.extensionUri, 'media'),
  ];
  if (documentUri.scheme === 'file') {
    roots.push(vscode.Uri.file(path.dirname(documentUri.fsPath)));
  }
  return roots;
}

/** 读取当前文档内容（文件可能已关闭，用 openTextDocument 兜底）。 */
function currentDocumentText(state: PanelState): string {
  return state.document.isClosed ? '' : state.document.getText();
}

/** 防抖：编辑产生的自动同步（只更新打开的文档，落盘交给 VS Code 自动保存 / Ctrl+S）。
 *  批量已由 webview 的 markdownUpdated(200ms) 完成，这里仅合并瞬时重复消息（30ms），
 *  使插件改动几乎即时反映到 VS Code 文档。 */
function scheduleSave(state: PanelState, content: string): void {
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    void applyContent(state, content, false);
  }, 30);
}

/**
 * 把 webview 的内容写回 VS Code 文档。
 * @param explicit 是否显式保存（工具栏"保存"按钮）：true 时同时写盘（Ctrl+S 语义）；
 *  false 时只更新打开的文档（标脏），磁盘写入交由 VS Code 自身的自动保存 / Ctrl+S 控制——
 *  这样本插件与普通文件行为一致：VS Code 开了自动保存才自动落盘。
 */
async function applyContent(state: PanelState, content: string, explicit = false): Promise<void> {
  const doc = state.document;
  if (doc.isClosed) return;
  const existing = doc.getText();
  if (existing === content) {
    state.lastSent = content;
    // 显式保存：文档可能已被自动同步持有最新内容但尚未写盘（isDirty）——
    // 此时内容一致仍必须 doc.save() 落盘，否则保存按钮/Ctrl+S 会被当"无变化"跳过
    if (explicit) {
      const saved = await doc.save();
      if (!saved) {
        const reply: HostToWebviewMessage = { type: 'notify', kind: 'error', text: '保存文件失败' };
        void state.panel.webview.postMessage(reply);
      }
    }
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  const whole = new vscode.Range(doc.positionAt(0), doc.positionAt(existing.length));
  edit.replace(doc.uri, whole, content);
  // 先标记 lastSent：本次 applyEdit 产生的变更事件（内容 = content）被 handleDocumentChanged
  // 当作回显跳过；同窗口期内用户在 VS Code 里的真实编辑（内容不同）不会被误拦。
  state.lastSent = content;
  try {
    await vscode.workspace.applyEdit(edit);
    if (explicit) {
      const saved = await doc.save();
      if (!saved) {
        const reply: HostToWebviewMessage = { type: 'notify', kind: 'error', text: '保存文件失败' };
        void state.panel.webview.postMessage(reply);
      }
    }
  } catch {
    const reply: HostToWebviewMessage = { type: 'notify', kind: 'error', text: '写入文件失败' };
    void state.panel.webview.postMessage(reply);
  }
}

function disposeState(state: PanelState): void {
  if (state.saveTimer) clearTimeout(state.saveTimer);
  panels.delete(state);
  for (const disposable of state.disposables.splice(0)) disposable.dispose();
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'webview.js')
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'webview.css')
  );
  const nonce = getNonce();
  const template = fs.readFileSync(path.join(__dirname, 'webview', 'index.html'), 'utf-8');
  return template
    .split('{{nonce}}')
    .join(nonce)
    .split('{{styleUri}}')
    .join(styleUri.toString())
    .split('{{scriptUri}}')
    .join(scriptUri.toString())
    .split('{{cspSource}}')
    .join(webview.cspSource);
}

/** 处理文档变更：VS Code 内编辑同一文档 → 通知面板刷新；自身写入（回显）→ 忽略。
 *  lastSent 表示"webview 已同步的最新内容"：内容与之相同视为回显/无变化跳过；
 *  不同则同步，且同步后立即更新 lastSent——否则用户"输入又删回原状"时，
 *  内容恰好等于旧 lastSent 会被误判为回显而漏同步（编辑器残留旧字符）。 */
export function handleDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
  if (!readSettings().syncFromDisk) return;
  for (const state of panels) {
    if (state.document.uri.toString() !== e.document.uri.toString()) continue;
    const content = e.document.getText();
    if (content === state.lastSent) continue;
    state.lastSent = content;
    const msg: HostToWebviewMessage = { type: 'external-change', content };
    void state.panel.webview.postMessage(msg);
  }
}
