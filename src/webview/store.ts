import type { EditorMode, MdEditorSettings } from '../messages';

export interface StoreState {
  mode: EditorMode;
  content: string;
  filePath: string;
  /** md 所在目录的 webview 资源根（带尾斜杠），用于解析相对图片路径。 */
  imageRoot: string;
  settings: MdEditorSettings;
  loaded: boolean;
}

type Listener = () => void;

const defaultSettings: MdEditorSettings = {
  defaultMode: 'wysiwyg',
  imageFolder: 'images',
  imageNameMode: 'timestamp',
  autoSaveDelay: 800,
  syncFromDisk: true,
  splitView: false,
  enableWikiLinks: true,
  theme: 'auto',
};

/** 单一数据源：三模式共享的 markdown 内容与元数据。 */
class Store {
  private state: StoreState = {
    mode: 'source',
    content: '',
    filePath: '',
    imageRoot: '',
    settings: defaultSettings,
    loaded: false,
  };

  private listeners = new Set<Listener>();

  get(): StoreState {
    return this.state;
  }

  set(patch: Partial<StoreState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
}

export const store = new Store();
