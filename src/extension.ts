import * as vscode from 'vscode';
import {
  broadcastSettingsChanged,
  handleDocumentChanged,
  MDEditorProvider,
  revealAnyPanel,
  VIEW_TYPE,
} from './panel';

/** 扩展激活入口。 */
export function activate(context: vscode.ExtensionContext): void {
  const provider = new MDEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('md-editor.open', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage('MD-Editor: 当前没有打开的文件');
        return;
      }
      if (editor.document.languageId !== 'markdown') {
        void vscode.window.showInformationMessage('MD-Editor: 当前文件不是 Markdown');
        return;
      }
      await vscode.commands.executeCommand(
        'vscode.openWith',
        editor.document.uri,
        VIEW_TYPE,
        vscode.ViewColumn.Beside
      );
    }),
    vscode.commands.registerCommand('md-editor.openDevtools', async () => {
      revealAnyPanel();
      await vscode.commands.executeCommand('workbench.action.webview.openDeveloperTools');
    }),
    vscode.workspace.onDidChangeTextDocument(handleDocumentChanged),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mdEditor')) broadcastSettingsChanged();
    })
  );
}

export function deactivate(): void {
  // 无全局资源需要释放
}
