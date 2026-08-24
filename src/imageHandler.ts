import * as path from 'path';
import * as vscode from 'vscode';
import { candidateNames, withSuffix } from './imageNaming';
import type { SaveImageInput } from './messages';
import { readSettings } from './settings';

/**
 * 保存粘贴/拖放的图片：写入 md 同目录的配置子目录（默认 images/），
 * 返回相对 md 文件的引用路径（正斜杠）。
 */
export async function saveImage(
  documentUri: vscode.Uri,
  input: SaveImageInput
): Promise<{ relativePath: string; absolutePath: string }> {
  if (documentUri.scheme !== 'file') {
    throw new Error('请先保存 Markdown 文件，图片需要写入本地目录');
  }
  const mdDir = path.dirname(documentUri.fsPath);
  const imageDir = path.join(mdDir, readSettings().imageFolder);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(imageDir));

  const names = candidateNames(
    readSettings().imageNameMode,
    input.originalName,
    input.mime,
    Date.now()
  );
  const first = names[0];

  // 碰撞时追加 -1/-2… 后缀，最多尝试 100 次
  let target = '';
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? first : withSuffix(first, i);
    const full = path.join(imageDir, candidate);
    if (!(await fileExists(full))) {
      target = full;
      break;
    }
  }
  if (!target) throw new Error('无法生成唯一的图片文件名');

  const bytes = Buffer.from(input.data, 'base64');
  await vscode.workspace.fs.writeFile(vscode.Uri.file(target), bytes);

  const relativePath = path.relative(mdDir, target).split(path.sep).join('/');
  return { relativePath, absolutePath: target };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(p));
    return true;
  } catch {
    return false;
  }
}
