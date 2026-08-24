import type { HostToWebviewMessage, WebviewToHostMessage } from '../messages';

interface VsCodeApi {
  postMessage(msg: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

const api: VsCodeApi = window.acquireVsCodeApi
  ? window.acquireVsCodeApi()
  : { postMessage: () => undefined };

/** 向扩展宿主发送消息。 */
export function postMessage(msg: WebviewToHostMessage): void {
  api.postMessage(msg);
}

/** 订阅宿主消息，返回取消订阅函数。 */
export function onMessage(handler: (msg: HostToWebviewMessage) => void): () => void {
  const listener = (ev: MessageEvent<HostToWebviewMessage>) => handler(ev.data);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
