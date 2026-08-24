const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const panel = fs.readFileSync(path.join(root, 'src', 'panel.ts'), 'utf8');
const extension = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
const messages = fs.readFileSync(path.join(root, 'src', 'messages.ts'), 'utf8');

const editor = manifest.contributes?.customEditors?.find((item) => item.viewType === 'md-editor.editor');
if (!editor) throw new Error('MD-Editor custom editor contribution is missing');
if (editor.priority !== 'option') throw new Error('MD-Editor must remain an optional custom editor');
if (!editor.selector?.some((item) => item.filenamePattern === '*.md')) {
  throw new Error('MD-Editor must target *.md files');
}
if (!panel.includes('implements vscode.CustomTextEditorProvider')) {
  throw new Error('Panel provider is not a CustomTextEditorProvider');
}
if (panel.includes('createWebviewPanel(') || panel.includes('setDirtyTitle')) {
  throw new Error('Legacy WebviewPanel title-based editor path remains');
}
if (!extension.includes("vscode.openWith") || !extension.includes("registerCustomEditorProvider")) {
  throw new Error('The command must open the registered custom editor');
}
if (messages.includes("type: 'dirty'")) throw new Error('Manual dirty protocol remains');

console.log('[custom-editor] native custom editor registration: OK');
