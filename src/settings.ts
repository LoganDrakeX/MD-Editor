import * as vscode from 'vscode';
import type { MdEditorSettings } from './messages';

const CONFIG_SECTION = 'mdEditor';

/** 读取当前配置（含默认值）。 */
export function readSettings(): MdEditorSettings {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    defaultMode: cfg.get<MdEditorSettings['defaultMode']>('defaultMode', 'wysiwyg'),
    imageFolder: cfg.get<string>('imageFolder', 'images'),
    imageNameMode: cfg.get<MdEditorSettings['imageNameMode']>('imageNameMode', 'timestamp'),
    autoSaveDelay: cfg.get<number>('autoSaveDelay', 800),
    syncFromDisk: cfg.get<boolean>('syncFromDisk', true),
    splitView: cfg.get<boolean>('splitView', false),
    enableWikiLinks: cfg.get<boolean>('enableWikiLinks', true),
    theme: cfg.get<MdEditorSettings['theme']>('theme', 'auto'),
  };
}
