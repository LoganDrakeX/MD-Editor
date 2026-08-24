/** 共用的轻量 markdown 内联解析与 slug 工具（大纲 / 预览 / 跳转共用）。 */
import MarkdownIt from 'markdown-it';

/** 轻量实例：仅用于把标题渲染成纯文本（与编辑器解析结果保持一致）。 */
const plainMd = new MarkdownIt();

/** 渲染行内 markdown 并去掉 HTML 标签，得到纯文本（如 `add_charts` 中的 `_` 不会被误删）。 */
export function inlinePlain(text: string): string {
  try {
    return plainMd
      .renderInline(text)
      .replace(/<[^>]+>/g, '')
      .trim();
  } catch {
    return text.trim();
  }
}

/** 去掉行内标记（加粗/斜体/删除线/反引号/双链括号），保留文字；下划线按字内下划线保留。 */
export function cleanInline(s: string): string {
  return s.replace(/[*~`]/g, '').replace(/\[\[|\]\]/g, '').trim();
}

export interface InlineSegment {
  text: string;
  code: boolean;
}

/** 解析行内格式：`` `代码` `` 拆成代码段，其余去掉标记符号。 */
export function parseInline(text: string): InlineSegment[] {
  const segs: InlineSegment[] = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ text: cleanInline(text.slice(last, m.index)), code: false });
    segs.push({ text: m[1], code: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ text: cleanInline(text.slice(last)), code: false });
  if (segs.length === 0) segs.push({ text: cleanInline(text), code: false });
  return segs.filter((s) => s.text.length > 0);
}

/** 与大纲/预览共用的标题 slug。 */
export function slugify(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'heading'
  );
}
