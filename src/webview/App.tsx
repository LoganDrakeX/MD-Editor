import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, useState } from 'react';
import { onMessage, postMessage } from './bridge';
import { attachImageCapture, fileToBase64 } from './imageCapture';
import { store } from './store';
import Toolbar from './Toolbar';
import Outline from './Outline';
import { extractOutline } from './Outline';
import type { OutlineHeading } from './Outline';
import { slugify } from './markdown';
import WysiwygMode from './modes/wysiwyg';
import type { EditorStateInfo, WysiwygApi } from './modes/wysiwyg';
import SourceMode from './modes/source';
import type { SourceApi } from './modes/source';
import PreviewMode from './modes/preview';

type EffectiveTheme = 'light' | 'dark';

/** 读取 VS Code 注入到 webview body 的主题类。 */
function detectVsCodeTheme(): EffectiveTheme {
  return document.body.classList.contains('vscode-dark') ||
    document.body.classList.contains('vscode-high-contrast')
    ? 'dark'
    : 'light';
}

/** 相对路径 → 图片引用 alt（取文件名去掉扩展名）。 */
function altFromPath(relativePath: string): string {
  const name = relativePath.split('/').pop() ?? 'image';
  return name.replace(/\.[^.]+$/, '') || 'image';
}

export default function App() {
  const s = useSyncExternalStore(
    (l) => store.subscribe(l),
    () => store.get()
  );
  const [saved, setSaved] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [wysiwygState, setWysiwygState] = useState<EditorStateInfo | null>(null);
  const [vsCodeTheme, setVsCodeTheme] = useState<EffectiveTheme>(() => detectVsCodeTheme());
  const [showOutline, setShowOutline] = useState(true);
  const [outlineWidth, setOutlineWidth] = useState(190);
  const wysiwygRef = useRef<WysiwygApi | null>(null);
  const sourceRef = useRef<SourceApi | null>(null);
  const lastPosted = useRef<string | null>(null);
  const postTimer = useRef<number | undefined>(undefined);
  const toastTimer = useRef<number | undefined>(undefined);

  // 设置中的主题：auto → 跟随 VS Code；否则强制浅/深
  const effectiveTheme: EffectiveTheme =
    s.settings.theme === 'dark'
      ? 'dark'
      : s.settings.theme === 'light'
        ? 'light'
        : vsCodeTheme;

  // VS Code 主题切换时自动跟随（仅 auto 模式生效）
  useEffect(() => {
    const observer = new MutationObserver(() => setVsCodeTheme(detectVsCodeTheme()));
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const showToast = useCallback((text: string, ms = 2600) => {
    setToast(text);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  }, []);

  // 相对图片路径通过 <base> 解析到 md 所在目录的 webview 资源根
  useEffect(() => {
    if (!s.imageRoot) return;
    let base = document.head.querySelector('base');
    if (!base) {
      base = document.createElement('base');
      document.head.appendChild(base);
    }
    base.setAttribute('href', s.imageRoot);
  }, [s.imageRoot]);

  // 粘贴/拖放图片 → base64 发给宿主保存
  useEffect(() => {
    const el = document.querySelector('.app');
    if (!el) return;
    return attachImageCapture(el as HTMLElement, (file) => {
      void fileToBase64(file)
        .then((data) => {
          postMessage({ type: 'save-image', data, mime: file.type, originalName: file.name });
          showToast('正在保存图片…');
        })
        .catch(() => showToast('读取剪贴板图片失败', 4000));
    });
  }, [showToast]);

  // 订阅宿主消息
  useEffect(
    () =>
      onMessage((msg) => {
        switch (msg.type) {
          case 'load':
            lastPosted.current = msg.content;
            store.set({
              content: msg.content,
              filePath: msg.filePath,
              imageRoot: msg.imageRoot,
              settings: msg.settings,
              mode: msg.settings.defaultMode,
              loaded: true,
            });
            setSaved(true);
            break;
          case 'settings-changed':
            store.set({ settings: msg.settings });
            break;
          case 'external-change':
            lastPosted.current = msg.content;
            store.set({ content: msg.content });
            setSaved(true);
            break;
          case 'image-saved': {
            const { relativePath } = msg;
            const alt = altFromPath(relativePath);
            const { mode, content } = store.get();
            if (mode === 'wysiwyg') {
              wysiwygRef.current?.insertImage(relativePath, alt);
            } else if (mode === 'source') {
              sourceRef.current?.insertAtCursor(`![${alt}](${relativePath})`);
            } else {
              // 预览模式无光标：追加到文档末尾（预览立即可见）
              const next = (content ? content.replace(/\s*$/, '') + '\n\n' : '') + `![${alt}](${relativePath})`;
              store.set({ content: next });
              lastPosted.current = next;
              postMessage({ type: 'content-changed', content: next });
            }
            showToast(`图片已保存: ${relativePath}`);
            break;
          }
          case 'image-save-error':
            showToast(`保存图片失败: ${msg.message}`, 5000);
            break;
          case 'notify':
            showToast(msg.text, msg.kind === 'error' ? 5000 : 2600);
            break;
        }
      }),
    [showToast]
  );

  // 告知宿主前端已就绪
  useEffect(() => {
    postMessage({ type: 'ready' });
  }, []);

  /** 任何模式下的用户编辑 → 更新 store 并通知宿主写回文档（批量由 markdownUpdated 的 200ms 防抖完成，此处不叠加延迟）。 */
  const updateContent = useCallback((md: string) => {
    store.set({ content: md });
    setSaved(false);
    if (postTimer.current) window.clearTimeout(postTimer.current);
    postTimer.current = window.setTimeout(() => {
      if (md === lastPosted.current) {
        // 内容与已发送一致 → 视为已同步（避免冗余 onChange 卡在"编辑中"）
        setSaved(true);
        return;
      }
      lastPosted.current = md;
      postMessage({ type: 'content-changed', content: md });
      setSaved(true);
    }, 0);
  }, []);

  const switchMode = useCallback((mode: 'wysiwyg' | 'source' | 'preview') => {
    store.set({ mode });
    if (mode === 'wysiwyg') {
      // 从 display:none 切回后让 ProseMirror 重新测量
      window.setTimeout(() => wysiwygRef.current?.refresh(), 60);
    }
  }, []);

  /** 仅在 WYSIWYG 模式下执行工具栏命令。 */
  const runWysiwyg = useCallback(
    (fn: (api: WysiwygApi) => void) => {
      if (s.mode !== 'wysiwyg') return;
      const api = wysiwygRef.current;
      if (api) fn(api);
    },
    [s.mode]
  );

  /** 主题切换按钮：在浅/深之间切换（auto 先解析为当前实际主题），并持久化为用户设置。 */
  const toggleTheme = useCallback(() => {
    const next: 'light' | 'dark' = effectiveTheme === 'dark' ? 'light' : 'dark';
    postMessage({ type: 'set-theme', theme: next });
  }, [effectiveTheme]);

  /** 主动保存（保存按钮 / Ctrl+S）：取 WYSIWYG 实时序列化，发 save-request 由宿主写盘。 */
  const performSave = useCallback(() => {
    const md = wysiwygRef.current?.getMarkdown?.() ?? store.get().content;
    postMessage({ type: 'save-request', content: md });
  }, []);

  // Ctrl+S 在插件内直接触发保存（与保存按钮一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();
        performSave();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [performSave]);

  // 大纲数据：随内容实时更新
  const outline = useMemo(() => extractOutline(s.content), [s.content]);

  /** 大纲跳转：按当前模式定位到标题。 */
  const jumpToHeading = useCallback(
    (h: OutlineHeading) => {
      if (s.mode === 'wysiwyg') {
        wysiwygRef.current?.jumpToHeading(h.level, h.text);
      } else if (s.mode === 'source') {
        sourceRef.current?.jumpToLine(h.text);
      } else {
        const el = document.getElementById(slugify(h.text));
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    },
    [s.mode]
  );

  return (
    <div className={'app mdw-' + effectiveTheme}>
      <Toolbar
        mode={s.mode}
        loaded={s.loaded}
        saved={saved}
        theme={s.settings.theme}
        effectiveTheme={effectiveTheme}
        fmt={wysiwygState}
        showOutline={showOutline}
        onToggleOutline={() => setShowOutline((v) => !v)}
        onSwitchMode={switchMode}
        onToggleTheme={toggleTheme}
        onSave={performSave}
        runWysiwyg={runWysiwyg}
      />

      <div className="app-body">
        {showOutline && (
          <Outline
            headings={outline}
            width={outlineWidth}
            onWidthChange={setOutlineWidth}
            onJump={jumpToHeading}
          />
        )}
        <main className="content">
        <div className={'mode-pane' + (s.mode === 'wysiwyg' ? ' active' : '')}>
          <WysiwygMode
            content={s.content}
            onChange={updateContent}
            apiRef={wysiwygRef}
            onStateChange={setWysiwygState}
          />
        </div>
        <div className={'mode-pane' + (s.mode === 'source' ? ' active' : '')}>
          <SourceMode content={s.content} onChange={updateContent} apiRef={sourceRef} />
        </div>
        <div className={'mode-pane' + (s.mode === 'preview' ? ' active' : '')}>
          <PreviewMode content={s.content} active={s.mode === 'preview'} />
        </div>
        </main>
      </div>

      {toast && <div className="toast">{toast}</div>}

      <footer className="statusbar">
        {s.filePath || '未加载文件'}
        {s.mode === 'source' ? ' · 源码' : s.mode === 'preview' ? ' · 预览' : ' · WYSIWYG'}
      </footer>
    </div>
  );
}
