import type { ComponentType } from 'react';
import type { AssistantPageProps, PanelTab } from './assistant-context';
import { AssistantMemoryPage } from './assistant-memory-page';
import { AssistantProfilePage } from './assistant-profile';
import { AssistantTasksPage } from './assistant-tasks';
import { AssistantTodayPage } from './assistant-today';

/**
 * 「助理」App 右边面板的挂载表(挂载接口,见同目录 README.md):胶囊那一排的四格 → 页组件。
 * 每一页自己按 `context.route.sub` 画往下钻的那几页。齿轮那一页(设置)在 assistant-profile.tsx。
 */
export const ASSISTANT_PAGES: Record<PanelTab, ComponentType<AssistantPageProps>> = {
  today: AssistantTodayPage,
  tasks: AssistantTasksPage,
  memory: AssistantMemoryPage,
  profile: AssistantProfilePage,
};
