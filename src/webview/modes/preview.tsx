import { useMemo } from 'react';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import { postMessage } from '../bridge';
import { inlinePlain, slugify } from '../markdown';
import { consumeListStyleMarker, preprocessExtendedLists } from '../listSyntax';

/** 渲染 [[页面|别名]] 双链的 markdown-it 内联规则。 */
function wikiLinkRule(state: any, silent: boolean): boolean {
  const src = state.src;
  if (src[state.pos] !== '[' || src[state.pos + 1] !== '[') return false;
  const end = src.indexOf(']]', state.pos + 2);
  if (end === -1) return false;
  const raw = src.slice(state.pos + 2, end);
  if (!raw || raw.includes('[') || raw.includes(']')) return false;
  if (!silent) {
    const [page, label] = raw.includes('|') ? raw.split('|') : [raw, raw];
    if (!page.trim()) return false;
    const open = state.push('wiki_link_open', 'a', 1);
    open.attrs = [
      ['href', 'wiki:' + encodeURIComponent(page.trim())],
      ['class', 'wiki-link'],
      ['data-page', page.trim()],
    ];
    const text = state.push('text', '', 0);
    text.content = (label || page).trim();
    state.push('wiki_link_close', 'a', -1);
  }
  state.pos = end + 2;
  return true;
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
      } catch {
        // 忽略单个代码块的高亮失败
      }
    }
    return ''; // 交由 markdown-it 转义
  },
});

md.inline.ruler.before('link', 'wiki_link', wikiLinkRule);

md.core.ruler.push('mdw_extended_lists', (state) => {
  const stack: number[] = [];
  for (let i = 0; i < state.tokens.length; i++) {
    const token = state.tokens[i];
    if (token.type === 'ordered_list_open') stack.push(i);
    else if (token.type === 'ordered_list_close') stack.pop();
    else if (token.type === 'inline' && stack.length && token.children?.[0]?.type === 'text') {
      const first = token.children[0];
      const metadata = consumeListStyleMarker(first.content);
      if (metadata) {
        state.tokens[stack[stack.length - 1]].attrSet('data-list-style', metadata.style);
        first.content = metadata.text;
      }
    }
  }
});
md.renderer.rules.wiki_link_open = (tokens, idx) => {
  const attrs = (tokens[idx].attrs ?? []).map(([k, v]) => `${k}="${v.replace(/"/g, '&quot;')}"`).join(' ');
  return `<a ${attrs}>`;
};
md.renderer.rules.wiki_link_close = () => '</a>';

/** 与大纲共用的标题 slug（去行内标记后生成，保证大纲点击可跳转）。 */
md.renderer.rules.heading_open = (tokens, idx) => {
  const token = tokens[idx];
  const level = token.tag.slice(1);
  const inline = tokens[idx + 1];
  const text = inline ? inlinePlain(inline.content) : '';
  return `<h${level} id="${slugify(text)}" class="mdw-heading">`;
};
md.renderer.rules.heading_close = (tokens, idx) => `</${tokens[idx].tag}>`;

// 代码块：外层包一个带语言角标的容器（与 WYSIWYG 风格一致）
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const info = token.info ? token.info.trim().split(/\s+/)[0] : '';
  const lang = info || '';
  const highlighted = lang
    ? md.options.highlight?.(token.content, lang, '') ?? ''
    : '';
  const code =
    highlighted && highlighted !== token.content
      ? highlighted
      : md.utils.escapeHtml(token.content);
  const codeAttr = lang ? ` class="language-${lang}"` : '';
  const badge = lang
    ? `<span class="mdw-codeblock-lang">${md.utils.escapeHtml(lang)}</span>`
    : '';
  return (
    `<div class="preview-code-wrap">` +
    badge +
    `<pre><code${codeAttr}>${code}</code></pre>` +
    `</div>`
  );
};

// 支持 Pandoc 风格图片宽度：![alt](src){width=400} → <img width="400">
md.core.ruler.push('mdw_img_width', (state) => {
  const walk = (tokens: any[]) => {
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.children) walk(token.children);
      if (token.type === 'image' && tokens[i + 1] && tokens[i + 1].type === 'text') {
        const m = /^\{width=(\d+)\}$/.exec(tokens[i + 1].content);
        if (m) {
          token.attrSet('width', m[1]);
          tokens.splice(i + 1, 1);
        }
      }
    }
  };
  walk(state.tokens);
});

// GFM 任务项预览：列表项段落开头的 "[ ] / [x] / [X] " → 只读复选框（markdown-it 默认不解析任务列表）
md.core.ruler.push('mdw_task_item', (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== 'inline' || !inline.children || inline.children.length === 0) continue;
    const parent = tokens[i - 1];
    const grand = tokens[i - 2];
    if (!parent || parent.type !== 'paragraph_open' || !grand || grand.type !== 'list_item_open') continue;
    const first = inline.children[0];
    if (!first || first.type !== 'text') continue;
    const m = /^\[( |x|X)\]\s?/.exec(first.content);
    if (!m) continue;
    const checked = m[1].toLowerCase() === 'x';
    first.content = first.content.slice(m[0].length);
    const cb = new state.Token('html_inline', '', 0);
    cb.content = `<input type="checkbox" class="mdw-task-cb" disabled${checked ? ' checked' : ''}> `;
    inline.children.unshift(cb);
  }
});

interface Props {
  content: string;
  /** 仅当预览模式可见时渲染（避免隐藏时每次按键都全量渲染 markdown）。 */
  active: boolean;
}

/** markdown-it 预览模式（只读，支持 [[wiki 双链]] 点击跳转）。 */
export default function PreviewMode({ content, active }: Props) {
  const html = useMemo(
    () => (active ? md.render(preprocessExtendedLists(content)) : ''),
    [content, active]
  );

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest('a');
    if (!target) return;
    const href = target.getAttribute('href') ?? '';
    if (href.startsWith('wiki:')) {
      e.preventDefault();
      const name = decodeURIComponent(href.slice('wiki:'.length));
      postMessage({ type: 'open-wiki', name });
      return;
    }
    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('#')) {
      return; // 外链/锚点交给默认行为
    }
    e.preventDefault(); // 其他相对链接暂不处理
  };

  return (
    <div className="preview" onClick={handleClick} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
