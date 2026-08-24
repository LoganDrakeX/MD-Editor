import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';

/** App 通过该 API 在光标处插入内容。 */
export interface SourceApi {
  insertAtCursor(text: string): void;
  /** 大纲跳转：定位到包含指定文本的标题行。 */
  jumpToLine(text: string): void;
}

interface Props {
  content: string;
  onChange(md: string): void;
  apiRef: MutableRefObject<SourceApi | null>;
}

/** CodeMirror 6 源码模式：编辑 markdown 原文。 */
export default function SourceMode({ content, onChange, apiRef }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastRef = useRef<string>(content);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const apiRefRef = useRef(apiRef);
  apiRefRef.current = apiRef;

  useEffect(() => {
    const view = new EditorView({
      parent: containerRef.current!,
      state: EditorState.create({
        doc: content,
        extensions: [
          basicSetup,
          markdown(),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const text = update.state.doc.toString();
            if (text === lastRef.current) return;
            lastRef.current = text;
            onChangeRef.current(text);
          }),
        ],
      }),
    });
    viewRef.current = view;
    apiRefRef.current.current = {
      insertAtCursor: (text: string) => {
        view.focus();
        view.dispatch(view.state.replaceSelection(text));
      },
      jumpToLine: (text: string) => {
        const lines = view.state.doc.toString().split('\n');
        const idx = lines.findIndex(
          (l) => l.trim().startsWith('#') && l.includes(text.trim())
        );
        if (idx < 0) return;
        const line = view.state.doc.line(idx + 1);
        view.dispatch({
          selection: { anchor: line.from },
          effects: EditorView.scrollIntoView(line.from, { y: 'start' }),
        });
        view.focus();
      },
    };
    return () => {
      view.destroy();
      viewRef.current = null;
      apiRefRef.current.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部内容变化（来自 WYSIWYG/预览/磁盘）→ 整篇替换
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (content === lastRef.current) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
    });
    lastRef.current = content;
  }, [content]);

  return <div ref={containerRef} className="cm-host" />;
}
