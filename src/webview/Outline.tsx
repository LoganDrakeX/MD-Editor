/** 左侧大纲面板：点击跳转、右缘拖动调宽、折叠/展开子级、行内代码渲染。 */
import { useState } from 'react';
import { inlinePlain, parseInline } from './markdown';
import type { InlineSegment } from './markdown';
import { IconChevronDown, IconChevronRight } from './icons';

export interface OutlineHeading {
  level: number;
  /** 纯文本（去格式），用于跳转匹配。 */
  text: string;
  /** 渲染分段（行内代码单独成段）。 */
  segments: InlineSegment[];
}

export function extractOutline(md: string): OutlineHeading[] {
  const out: OutlineHeading[] = [];
  for (const line of md.split('\n')) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m && m[2].trim()) {
      const raw = m[2].trim();
      const segments = parseInline(raw);
      if (segments.length === 0) continue;
      out.push({
        level: m[1].length,
        text: inlinePlain(raw),
        segments,
      });
    }
  }
  return out;
}

interface Props {
  headings: OutlineHeading[];
  width: number;
  onWidthChange(w: number): void;
  onJump(h: OutlineHeading): void;
}

/** 左侧大纲面板：点击跳转，右缘可拖动改宽度，支持折叠/展开子级。 */
export default function Outline({ headings, width, onWidthChange, onJump }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  // 折叠时只显示一级标题
  const visible = collapsed ? headings.filter((h) => h.level === 1) : headings;

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: MouseEvent) => {
      onWidthChange(Math.min(420, Math.max(140, startW + (ev.clientX - startX))));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <aside className="outline" style={{ width }}>
      <div className="outline-header">
        <span className="outline-title">大纲</span>
        <div className="outline-header-actions">
          {/* 折叠/展开：单一按钮，只显示与当前状态相反的操作 icon（▾=折叠子级，▸=展开子级） */}
          <button
            className="outline-fold"
            title={collapsed ? '展开全部子级' : '折叠子级（只显示一级标题）'}
            onClick={() => setCollapsed((v) => !v)}
          >
            {collapsed ? <IconChevronRight /> : <IconChevronDown />}
          </button>
        </div>
      </div>
      <div className="outline-body">
        {visible.length === 0 ? (
          <div className="outline-empty">暂无标题</div>
        ) : (
          visible.map((h, i) => (
            <button
              key={i}
              className="outline-item"
              style={{ paddingLeft: 10 + (h.level - 1) * 14 }}
              title={h.text}
              onClick={() => onJump(h)}
            >
              {h.segments.map((s, si) =>
                s.code ? (
                  <code key={si} className="outline-code">
                    {s.text}
                  </code>
                ) : (
                  <span key={si}>{s.text}</span>
                )
              )}
            </button>
          ))
        )}
      </div>
      <div className="outline-resizer" title="拖动调整宽度" onMouseDown={startDrag} />
    </aside>
  );
}
