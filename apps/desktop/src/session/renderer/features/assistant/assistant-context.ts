import { createContext } from 'react';
import type { CloudComputerSnapshot } from '@gugu/core/cloud/cloudComputer';
import type { AssistantHomePlace } from '@/lib/assistantHome';
import type { AssistantShellAssistant } from '@/lib/assistantShellBridge';
import type { MachineReadiness } from './assistant-data';
import type { AssistantMachine } from './assistant-machine';
import type { AssistantOwner } from './assistant-ui-parts';

/**
 * 右边面板顶上那一排胶囊(动态 / 任务 / 记忆 / 资料)。聊天不是一格:左边一整列就是它。
 * 齿轮(左边那一排右上)直接打开全局设置并停在「咕咕」那一组(owner 10-16「❌ 再有第二个设置页」),不是面板里的一页。
 */
export const PANEL_TABS = ['today', 'tasks', 'memory', 'profile'] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

/**
 * 面板此刻是哪一页。`sub` = 往下钻到的子页(往下钻时左上出返回箭头):
 * - profile:`diaries`、`diary:<id>`、`devices`、`connectors`(连接列表也直接展开在资料首页;聊天工具在全局设置里)
 * - tasks:`routine:<id>`
 * - memory:`note:<文件名>`、`files`、`files:<相对路径>`、`voice`、`voice:<id>`(一条语音笔记)
 */
export type PanelRoute = { tab: PanelTab; sub?: string };

/** 返回箭头回到哪:详情回列表,列表回所在那一格的首页。 */
export function parentRoute(route: PanelRoute): PanelRoute | null {
  const sub = route.sub;
  if (!sub) return null;
  if (sub.startsWith('voice:')) return { tab: route.tab, sub: 'voice' };
  if (sub.startsWith('files:')) {
    const rest = sub.slice('files:'.length);
    const cut = rest.lastIndexOf('/');
    return { tab: route.tab, sub: cut > 0 ? `files:${rest.slice(0, cut)}` : 'files' };
  }
  return { tab: route.tab };
}

/**
 * 每一页拿到的(挂载接口,见 features/assistant/README.md):是谁、住在哪台、那台此刻能不能读、读它用的工作区、怎么往下钻。
 */
export type AssistantContext = {
  assistant: AssistantShellAssistant;
  ownerName: string | null;
  /** 主人自己(记忆页「关于你」用他的头像打头);认不出 = null。 */
  owner?: AssistantOwner | null;
  /** 和它的那条私聊(壳认出来的;还没认出来 = null):「今天」页读它文件夹里的 today.json。 */
  chatId: string | null;
  /** 执行宿主的位置；面板数据始终读取账号云端副本。 */
  home: AssistantHomePlace;
  /** 它家那台的设备 id(查询键、会话目录、已安排都按它)。 */
  homeDeviceId: string;
  /** 住云上时管家给的样子;住电脑 = null。 */
  snapshot: CloudComputerSnapshot | null;
  readiness: MachineReadiness;
  /** 账号级面板读写接口；未能确定归属时为 undefined。 */
  machine: AssistantMachine | undefined;
  machineLoading: boolean;
  machineError: unknown;
  retryMachine: () => void;
  route: PanelRoute;
  go: (route: PanelRoute) => void;
  /** 把这句话(和要带上的文件)填进左边和它聊天的输入框(只填不发,人看过再发)—— 各页「问问它 / 改一下」都是这一下。 */
  askInChat: (draft?: string, files?: File[]) => void;
};

export type AssistantPageProps = { context: AssistantContext };

/** 面板元件共享助理身份和云端读取状态;各页仍以 props 收 context。 */
export const AssistantCtx = createContext<AssistantContext | null>(null);
