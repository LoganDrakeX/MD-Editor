/** 图片文件命名与 mime 映射的纯函数（无 vscode 依赖，可单测）。 */
import type { ImageNameMode } from './messages';

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
};

/** mime → 文件扩展名（不含点）。未知类型回退到 fallback。 */
export function mimeToExtension(mime: string, fallback = 'png'): string {
  return MIME_EXT[mime.toLowerCase()] ?? fallback;
}

/** 去掉 Windows/Unix 文件名非法字符与首部点号。 */
export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  return cleaned || 'image';
}

/** 拆分基名与扩展名（扩展名小写，无点）。 */
export function splitExt(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot > 0) return { base: name.slice(0, dot), ext: name.slice(dot + 1).toLowerCase() };
  return { base: name, ext: '' };
}

/** 按命名策略生成候选文件名（不含路径）。碰撞由调用方追加 -1/-2 后缀。 */
export function candidateNames(
  mode: ImageNameMode,
  originalName: string,
  mime: string,
  timestamp: number
): string[] {
  const ext = mimeToExtension(mime);
  const { base } = splitExt(originalName);
  const safeBase = sanitizeFileName(base || 'image');
  switch (mode) {
    case 'original': {
      const full = sanitizeFileName(originalName);
      return [full.includes('.') ? full : `${safeBase}.${ext}`];
    }
    case 'timestamp':
      return [`${timestamp}.${ext}`];
    case 'timestamp-original':
    default:
      return [`${timestamp}-${safeBase}.${ext}`];
  }
}

/** 文件名碰撞时追加 -n 后缀（保留扩展名）。 */
export function withSuffix(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name}-${n}`;
  return `${name.slice(0, dot)}-${n}${name.slice(dot)}`;
}
