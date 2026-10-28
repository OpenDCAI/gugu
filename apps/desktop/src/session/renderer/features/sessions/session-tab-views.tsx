import { lazy, type ComponentType } from 'react';
import type { TabContentProps } from '@renderer/features/tabs/core/tab-provider';
import { registerTabViews } from '@renderer/features/tabs/core/tab-views';
import { getAcpChatResourceManager } from './acp/acp-chat-resource-manager';
import { installAcpChatResources } from './acp/acp-chat-resources';

/**
 * 任务页各种页签的「界面那半」(见 tabs/core/tab-views.tsx 的 @@@tab-views)。
 * ⚠️ 只许任务页入口(embedded.tsx)import 这个文件:下面的 import() 写在这里,手机不加载任务页入口,就够不着这些
 * 内容组件和它们连着的编辑器、对话面板、diff;写进 provider 里,它们就跟着 provider 进了手机包(phone-web-dir 按引用收)。
 */
type TabViewModule = { TabContent: ComponentType<TabContentProps> };

const loaders: Record<string, () => Promise<TabViewModule>> = {
  session: () => import('./session-tab-view'),
  'acp-chat': () => import('./acp/acp-chat-tab-view'),
  'side-chat': () => import('./acp/side-chat-tab-view'),
  'file-browser': () => import('./editor/file-browser-tab-view'),
  file: () => import('./editor/file-tab-view'),
  review: () => import('./diff-view/review-tab-view'),
  diff: () => import('./diff-view/diff-tab-view'),
  browser: () => import('../browser/browser-tab-view'),
  terminal: () => import('./terminals/terminal-tab-view'),
  'remote-ports': () => import('../remote-hosts/workspace/remote-ports-tab-view'),
  'cloud-browser': () => import('../remote-hosts/workspace/cloud-browser-tab-view'),
};

export const SESSION_TAB_VIEW_KINDS = Object.keys(loaders);

export function installSessionTabViews(): void {
  installAcpChatResources(getAcpChatResourceManager);
  registerTabViews(
    Object.fromEntries(
      Object.entries(loaders).map(([kind, load]) => [kind, lazy(() => load().then((m) => ({ default: m.TabContent })))]),
    ),
  );
}

/** 桌面空闲时把各页签的界面那半先载进来:第一次打开某种页签就不用再等下载、解析。载失败不吞:真打开那一下会再载一次并报错。 */
export function prewarmSessionTabViews(): void {
  for (const load of Object.values(loaders)) void load();
}
