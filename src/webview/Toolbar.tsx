import { useState } from 'react';
import type { ReactNode } from 'react';
import type { EditorMode, ThemeName } from '../messages';
import type { EditorStateInfo, WysiwygApi } from './modes/wysiwyg';
import {
  IconBold,
  IconChevronDown,
  IconCode,
  IconHr,
  IconImage,
  IconItalic,
  IconLink,
  IconListOl,
  IconListUl,
  IconMoon,
  IconOutline,
  IconRedo,
  IconSave,
  IconStrike,
  IconSun,
  IconTable,
  IconTask,
  IconUndo,
} from './icons';

const MODES: { id: EditorMode; label: string; hint: string }[] = [
  { id: 'wysiwyg', label: 'WYSIWYG', hint: '所见即所得' },
  { id: 'source', label: '源码', hint: 'Markdown 原文' },
  { id: 'preview', label: '预览', hint: '渲染结果' },
];

const STYLE_OPTIONS: { label: string; level?: number; run: (api: WysiwygApi) => void }[] = [
  { label: '普通文本', run: (api) => api.paragraph() },
  { label: '标题 1', level: 1, run: (api) => api.heading(1) },
  { label: '标题 2', level: 2, run: (api) => api.heading(2) },
  { label: '标题 3', level: 3, run: (api) => api.heading(3) },
  { label: '标题 4', level: 4, run: (api) => api.heading(4) },
  { label: '标题 5', level: 5, run: (api) => api.heading(5) },
  { label: '标题 6', level: 6, run: (api) => api.heading(6) },
  { label: '代码块', run: (api) => api.codeBlock() },
];

function Divider() {
  return <span className="tb-divider" aria-hidden="true" />;
}

interface BtnProps {
  title: string;
  disabled?: boolean;
  active?: boolean;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}

function ToolbarButton({ title, disabled, active, className, onClick, children }: BtnProps) {
  return (
    <button
      className={'toolbar-btn' + (active ? ' active' : '') + (className ? ' ' + className : '')}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

interface DropdownProps {
  disabled?: boolean;
  trigger: ReactNode;
  triggerTitle: string;
  open: boolean;
  onToggle: () => void;
  menuClassName?: string;
  children: ReactNode;
}

function Dropdown({ disabled, trigger, triggerTitle, open, onToggle, menuClassName, children }: DropdownProps) {
  return (
    <div className={'dropdown' + (open ? ' open' : '')}>
      <ToolbarButton title={triggerTitle} disabled={disabled} onClick={onToggle}>
        {trigger}
      </ToolbarButton>
      {open && (
        <>
          <div className="dropdown-overlay" onClick={onToggle} />
          <div className={'dropdown-menu ' + (menuClassName ?? '')}>{children}</div>
        </>
      )}
    </div>
  );
}

function MenuItem({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button className={'dropdown-item' + (active ? ' active' : '')} onClick={onClick}>
      <span className={'dd-check' + (active ? ' on' : '')}>{active ? '✓' : ''}</span>
      <span className="dd-label">{children}</span>
    </button>
  );
}

export interface ToolbarProps {
  mode: EditorMode;
  loaded: boolean;
  saved: boolean;
  theme: ThemeName;
  effectiveTheme: 'light' | 'dark';
  /** WYSIWYG 光标处的格式状态（用于按钮高亮），null = 编辑器未就绪。 */
  fmt: EditorStateInfo | null;
  showOutline: boolean;
  onToggleOutline(): void;
  onSwitchMode(mode: EditorMode): void;
  onToggleTheme(): void;
  /** 工具栏"保存"按钮：立即把当前内容写盘（Ctrl+S 语义）。 */
  onSave(): void;
  /** 在 WYSIWYG 模式下执行命令；其他模式为 no-op。 */
  runWysiwyg(fn: (api: WysiwygApi) => void): void;
}

export default function Toolbar(props: ToolbarProps) {
  const {
    mode,
    loaded,
    saved,
    theme,
    effectiveTheme,
    fmt,
    showOutline,
    onToggleOutline,
    onSwitchMode,
    onToggleTheme,
    onSave,
    runWysiwyg,
  } = props;
  const [openMenu, setOpenMenu] = useState<null | 'mode' | 'style' | 'link' | 'image' | 'table'>(null);
  const [linkValue, setLinkValue] = useState('');
  const [imageValue, setImageValue] = useState('');
  const [gridSize, setGridSize] = useState({ r: 3, c: 3 });

  const disabled = mode !== 'wysiwyg' || !loaded;
  const exec = (fn: (api: WysiwygApi) => void) => {
    runWysiwyg(fn);
    setOpenMenu(null);
  };

  const currentModeLabel = MODES.find((m) => m.id === mode)?.label ?? 'WYSIWYG';

  // 段落样式下拉的当前显示与高亮
  const styleLabel = fmt
    ? fmt.heading
      ? `标题 ${fmt.heading}`
      : fmt.codeBlock
        ? '代码块'
        : '普通文本'
    : '普通文本';
  const isStyleActive = (opt: (typeof STYLE_OPTIONS)[number]) =>
    opt.level !== undefined
      ? fmt?.heading === opt.level
      : opt.label === '普通文本'
        ? fmt != null && !fmt.heading && !fmt.codeBlock
        : !!fmt?.codeBlock;

  const confirmLink = () => {
    const href = linkValue.trim();
    if (href) exec((api) => api.link(href));
    setLinkValue('');
  };
  const confirmImage = () => {
    const src = imageValue.trim();
    if (src) {
      const alt = src.split('/').pop()?.replace(/\.[^.]+$/, '') || 'image';
      exec((api) => api.insertImage(src, alt));
    }
    setImageValue('');
  };

  const isDark = effectiveTheme === 'dark';
  const themeLabel =
    theme === 'auto' ? '自动主题' : theme === 'dark' ? '深色主题' : '浅色主题';

  return (
    <header className="toolbar">
      {/* 模式下拉：只显示当前模式，点击展开其他选项 */}
      <Dropdown
        triggerTitle="切换模式"
        open={openMenu === 'mode'}
        onToggle={() => setOpenMenu(openMenu === 'mode' ? null : 'mode')}
        trigger={
          <span className="tb-dropdown-label">
            <span className="tb-dropdown-text">{currentModeLabel}</span>
            <IconChevronDown />
          </span>
        }
      >
        {MODES.map((m) => (
          <MenuItem
            key={m.id}
            active={mode === m.id}
            onClick={() => {
              onSwitchMode(m.id);
              setOpenMenu(null);
            }}
          >
            {m.label}
          </MenuItem>
        ))}
      </Dropdown>

      <Divider />

      {/* 段落样式下拉（Jira: "Normal text"），含 H1~H6 */}
      <Dropdown
        disabled={disabled}
        triggerTitle="段落样式"
        open={openMenu === 'style'}
        onToggle={() => setOpenMenu(openMenu === 'style' ? null : 'style')}
        trigger={
          <span className="tb-dropdown-label">
            <span className="tb-dropdown-text">{styleLabel}</span>
            <IconChevronDown />
          </span>
        }
      >
        {STYLE_OPTIONS.map((opt) => (
          <MenuItem key={opt.label} active={isStyleActive(opt)} onClick={() => exec(opt.run)}>
            {opt.label}
          </MenuItem>
        ))}
      </Dropdown>

      <Divider />

      {/* 大纲开关（加粗之前） */}
      <ToolbarButton
        className="outline-toggle"
        title={showOutline ? '隐藏大纲' : '显示大纲'}
        active={showOutline}
        onClick={onToggleOutline}
      >
        <IconOutline />
      </ToolbarButton>

      <ToolbarButton title="加粗 (Ctrl+B)" disabled={disabled} active={!!fmt?.bold} onClick={() => exec((a) => a.bold())}>
        <IconBold />
      </ToolbarButton>
      <ToolbarButton title="斜体 (Ctrl+I)" disabled={disabled} active={!!fmt?.italic} onClick={() => exec((a) => a.italic())}>
        <IconItalic />
      </ToolbarButton>
      <ToolbarButton title="删除线" disabled={disabled} active={!!fmt?.strike} onClick={() => exec((a) => a.strike())}>
        <IconStrike />
      </ToolbarButton>

      <Divider />

      <ToolbarButton title="无序列表" disabled={disabled} active={!!fmt?.bullet} onClick={() => exec((a) => a.bulletList())}>
        <IconListUl />
      </ToolbarButton>
      <ToolbarButton title="有序列表" disabled={disabled} active={!!fmt?.ordered} onClick={() => exec((a) => a.orderedList())}>
        <IconListOl />
      </ToolbarButton>
      <ToolbarButton title="任务列表" disabled={disabled} active={!!fmt?.task} onClick={() => exec((a) => a.taskList())}>
        <IconTask />
      </ToolbarButton>

      <Divider />

      <ToolbarButton title="代码块" disabled={disabled} active={!!fmt?.codeBlock} onClick={() => exec((a) => a.codeBlock())}>
        <IconCode />
      </ToolbarButton>

      {/* 表格：弹出行×列选择器 */}
      <Dropdown
        disabled={disabled}
        triggerTitle="插入表格（选择行列数）"
        open={openMenu === 'table'}
        onToggle={() => setOpenMenu(openMenu === 'table' ? null : 'table')}
        trigger={<IconTable />}
        menuClassName="table-grid-menu"
      >
        <div className="table-grid" onMouseLeave={() => setGridSize({ r: 1, c: 1 })}>
          {Array.from({ length: 6 }, (_, r) =>
            Array.from({ length: 6 }, (_, c) => (
              <div
                key={`${r}-${c}`}
                className={'tg-cell' + (r < gridSize.r && c < gridSize.c ? ' hover' : '')}
                onMouseEnter={() => setGridSize({ r: r + 1, c: c + 1 })}
                onClick={() => exec((a) => a.table(r + 1, c + 1))}
              />
            ))
          )}
        </div>
        <div className="table-grid-label">
          {gridSize.r} × {gridSize.c}
        </div>
      </Dropdown>

      <Divider />

      <Dropdown
        disabled={disabled}
        triggerTitle="插入链接"
        open={openMenu === 'link'}
        onToggle={() => setOpenMenu(openMenu === 'link' ? null : 'link')}
        trigger={<IconLink />}
      >
        <div className="tb-popover">
          <input
            className="tb-input"
            autoFocus
            placeholder="输入链接地址…"
            value={linkValue}
            onChange={(e) => setLinkValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmLink();
            }}
          />
          <div className="tb-popover-actions">
            <button className="tb-btn-primary" onClick={confirmLink}>
              插入
            </button>
            <button className="tb-btn-plain" onClick={() => setOpenMenu(null)}>
              取消
            </button>
          </div>
        </div>
      </Dropdown>

      <Dropdown
        disabled={disabled}
        triggerTitle="插入图片"
        open={openMenu === 'image'}
        onToggle={() => setOpenMenu(openMenu === 'image' ? null : 'image')}
        trigger={<IconImage />}
      >
        <div className="tb-popover">
          <input
            className="tb-input"
            autoFocus
            placeholder="图片路径或 URL（也可直接粘贴图片）"
            value={imageValue}
            onChange={(e) => setImageValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmImage();
            }}
          />
          <div className="tb-popover-actions">
            <button className="tb-btn-primary" onClick={confirmImage}>
              插入
            </button>
            <button className="tb-btn-plain" onClick={() => setOpenMenu(null)}>
              取消
            </button>
          </div>
        </div>
      </Dropdown>

      <ToolbarButton title="分割线" disabled={disabled} onClick={() => exec((a) => a.hr())}>
        <IconHr />
      </ToolbarButton>

      <Divider />

      <ToolbarButton title="撤销" disabled={disabled} onClick={() => exec((a) => a.undo())}>
        <IconUndo />
      </ToolbarButton>
      <ToolbarButton title="重做" disabled={disabled} onClick={() => exec((a) => a.redo())}>
        <IconRedo />
      </ToolbarButton>

      <Divider />

      <ToolbarButton title="保存" disabled={!loaded} onClick={onSave}>
        <IconSave />
      </ToolbarButton>

      <div className="toolbar-spacer" />

      <div className="toolbar-status" title={saved ? '内容已同步到文件' : '正在同步…'}>
        <span className={'save-dot' + (saved ? ' saved' : '')} />
        {saved ? '已同步' : '编辑中…'}
      </div>

      <ToolbarButton
        className="theme-toggle"
        title={'切换主题（当前: ' + themeLabel + '）'}
        onClick={onToggleTheme}
      >
        {isDark ? <IconSun /> : <IconMoon />}
      </ToolbarButton>
    </header>
  );
}
