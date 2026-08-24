/** Webview 侧图片捕获：粘贴/拖放 → base64。纯函数可单测。 */

/** 从剪贴板 items 中找第一个图片文件；items 不可用时回退到 files。 */
export function imageFileFromClipboard(
  items: ArrayLike<{ type: string; getAsFile?: () => File | null }> | null,
  files?: ArrayLike<File> | null
): File | null {
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/') && item.getAsFile) {
        const file = item.getAsFile();
        if (file) return file;
      }
    }
  }
  if (files) {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.type.startsWith('image/')) return f;
    }
  }
  return null;
}

/** 文件 → base64（去掉 dataURL 前缀）。 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

export type OnImageFile = (file: File) => void;

/** 在容器上监听 paste/drop，命中图片时回调并阻止默认行为；返回清理函数。 */
export function attachImageCapture(container: HTMLElement, onImageFile: OnImageFile): () => void {
  const sendFile = (file: File) => {
    if (!file.type.startsWith('image/')) return;
    onImageFile(file);
  };

  const onPaste = (e: ClipboardEvent) => {
    const file = imageFileFromClipboard(e.clipboardData?.items ?? null, e.clipboardData?.files ?? null);
    if (!file) return;
    e.preventDefault();
    sendFile(file);
  };

  const onDrop = (e: DragEvent) => {
    const files = Array.from(e.dataTransfer?.files ?? []);
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;
    e.preventDefault();
    for (const f of images) sendFile(f);
  };

  container.addEventListener('paste', onPaste);
  container.addEventListener('drop', onDrop);
  return () => {
    container.removeEventListener('paste', onPaste);
    container.removeEventListener('drop', onDrop);
  };
}
