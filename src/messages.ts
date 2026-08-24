/** 扩展宿主与 Webview 之间共享的消息类型与设置定义。 */

export type EditorMode = 'wysiwyg' | 'source' | 'preview';

export type ImageNameMode = 'original' | 'timestamp' | 'timestamp-original';

export type ThemeName = 'auto' | 'light' | 'dark';

export interface MdEditorSettings {
  defaultMode: EditorMode;
  imageFolder: string;
  imageNameMode: ImageNameMode;
  autoSaveDelay: number;
  syncFromDisk: boolean;
  splitView: boolean;
  enableWikiLinks: boolean;
  /** auto = 跟随 VS Code 主题。 */
  theme: ThemeName;
}

/** 宿主 -> Webview */
export type HostToWebviewMessage =
  | {
      type: 'load';
      content: string;
      filePath: string;
      /** md 所在目录的 webview 资源根（带尾斜杠），用于解析相对图片路径。 */
      imageRoot: string;
      settings: MdEditorSettings;
    }
  | { type: 'settings-changed'; settings: MdEditorSettings }
  | { type: 'external-change'; content: string }
  | { type: 'image-saved'; relativePath: string; absolutePath: string }
  | { type: 'image-save-error'; message: string }
  | { type: 'notify'; kind: 'error' | 'info'; text: string };

/** Webview -> 宿主 */
export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'content-changed'; content: string }
  | { type: 'save-request'; content: string }
  | { type: 'save-image'; data: string; mime: string; originalName: string }
  | { type: 'open-wiki'; name: string }
  | { type: 'open-external'; href: string }
  | { type: 'set-theme'; theme: ThemeName }
  | { type: 'log'; text: string };

/** save-image 消息的载荷（宿主侧 saveImage 入参）。 */
export type SaveImageInput = Extract<WebviewToHostMessage, { type: 'save-image' }>;
