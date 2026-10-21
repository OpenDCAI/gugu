import { Folder, Globe, SquareTerminal } from '@/lib/icons';
import { GitFork, GitPullRequest } from 'lucide-react';
import { ExtensionMark } from '@renderer/features/extensions/extension-mark';
import type { SessionMessageKey } from '@renderer/localization/messages';
import type { ExtensionTabKind } from '@shared/extensions/manifest';
import type { WorkspacePanelAction } from './pane-empty-state';
import type { RemoteHostDevice } from '@/session/shared/remote-hosts';
import { directToolsUnavailableText } from '../remote-hosts/workspace/remote-workspace-routing';

/**
 * What the workspace panel offers while a task is still a draft.
 *
 * Kept out of the panel component, and out of the app-state graph, so it can be judged
 * on its own. The draft panel predates the tab engine and keeps its own tab list; a list
 * built inline inside that component is exactly how this surface came to offer a
 * different set than the session panel did (#2374).
 */

const BUILTIN_DRAFT_TABS = ['terminal', 'browser', 'files'] as const;
export type DraftBuiltinTab = (typeof BUILTIN_DRAFT_TABS)[number];

/**
 * Extension surfaces share the draft strip with the built-ins under their own kind. The
 * dot in an extension kind is what separates the two at the type level, so this surface
 * admits them without widening itself to plain string.
 */
export type DraftTab = DraftBuiltinTab | ExtensionTabKind;

export function isBuiltinDraftTab(tab: DraftTab): tab is DraftBuiltinTab {
  return (BUILTIN_DRAFT_TABS as readonly string[]).includes(tab);
}

/**
 * 草稿阶段在别的机器上够不着的内置项,及每项的原因(#6264)。草稿右侧那几格跑在**这台电脑**上;
 * 选了别的机器时它们一律灰着说原因 —— ❌ 照常可点(那样终端会开在这台电脑上,owner 以为在那台机器上)。
 * 完整能力披露:项照列,不删。
 */
export type DraftBlocked = Partial<Record<DraftBuiltinTab, string>>;

export function draftToolsBlockedOnMachine(
  direct: boolean,
  translate: (key: SessionMessageKey) => string,
  /** 那台机器(远程隧道此刻怎样、是不是云电脑):够不着时据此说原因,❌ 一律说「去用远程 SSH 添加」。 */
  device: Pick<RemoteHostDevice, 'tunnel' | 'cloudComputer'> | null = null
): DraftBlocked {
  const afterSend = translate('task.machineToolsAfterSend');
  // 此刻没有直连的路:终端 / 浏览器根本开不了;说为什么(远程隧道在连 / 连不上 …),❌ 说「发送后可用」骗人。
  const directOnly = direct ? afterSend : directToolsUnavailableText(device, translate);
  return { terminal: directOnly, browser: directOnly, files: afterSend };
}

export function draftWorkspaceEntries({
  canOpenTerminal,
  canOpenFiles,
  blocked = {},
  extensions,
  translate,
  onOpen
}: {
  canOpenTerminal: boolean;
  canOpenFiles: boolean;
  /** 选了别的机器时,这几项灰着、悬停说原因(draftToolsBlockedOnMachine)。 */
  blocked?: DraftBlocked;
  /** 启用着的 App(behavior tab-extensions):停用的不在这里出现。 */
  extensions: readonly {
    kind: ExtensionTabKind;
    title: string;
    iconDataUrl?: string | null;
    extensionId: string;
  }[];
  translate: (key: SessionMessageKey) => string;
  /** 内置的那几格与 App 都走它:App 放到这里(它原来摆在哪条会话里就从哪拿走,一个 App 只有一份)。 */
  onOpen: (tab: DraftTab) => void;
}): WorkspacePanelAction[] {
  // 一份清单,与会话页那份同序同项(getSessionWorkspaceActionOrder)。够不着的项**渲染成
  // disabled 并说明原因**,❌ 不从清单里删 —— owner 2026-08-21:「没绑项目咋了,侧边聊天和文件
  // 应该也得有,之前没有是想先做减法,现在有才是产品正常形态」。删掉的项让人以为产品没这功能;
  // disabled + 原因才说清「有,但现在够不着,因为 X」。
  //
  // ⚠️ 这里曾经按 hasExplicitProject 分两支:没绑项目就只给浏览器+终端。真机上那正是 owner 数出的
  // 「少了两个」—— 而隐式 task-home 本身就是一个 git 仓库,没有任何理由不给文件。
  const builtins: WorkspacePanelAction[] = [
    {
      id: 'side-session',
      label: translate('workspace.sideTask'),
      icon: <GitFork className="size-3.5" />,
      // 草稿页上还没有会话可分叉 —— 这是「时序上够不着」,不是「这条任务没有这功能」。
      disabled: true,
      title: translate('task.sideTaskAfterSend'),
      onClick: () => undefined
    },
    {
      id: 'review',
      label: translate('workspace.review'),
      icon: <GitPullRequest className="size-3.5" />,
      disabled: true,
      title: translate('task.reviewAfterSend'),
      onClick: () => undefined
    },
    {
      id: 'terminal',
      label: translate('workspace.terminal'),
      icon: <SquareTerminal className="size-3.5" />,
      disabled: !canOpenTerminal || Boolean(blocked.terminal),
      ...(blocked.terminal ? { title: blocked.terminal } : {}),
      onClick: () => onOpen('terminal')
    },
    {
      id: 'browser',
      label: translate('workspace.browser'),
      icon: <Globe className="size-3.5" />,
      disabled: Boolean(blocked.browser),
      ...(blocked.browser ? { title: blocked.browser } : {}),
      onClick: () => onOpen('browser')
    },
    {
      id: 'files',
      label: translate('workspace.files'),
      icon: <Folder className="size-3.5" />,
      disabled: !canOpenFiles || Boolean(blocked.files),
      ...(blocked.files
        ? { title: blocked.files }
        : canOpenFiles
          ? {}
          : { title: translate('task.filesNeedWorkspace') }),
      onClick: () => onOpen('files')
    }
  ];

  // Extensions form their own group rather than continuing the built-in list — a workspace
  // with a dozen of them still reads as「应用会做的」加「我装的」, not one list that keeps
  // growing (behavior tab-extensions 增量③).
  //
  // 与「+」菜单、面板空态同一套语义:只列启用的,点一个 = 把它放到这里(behavior tab-extensions,#7052)。
  return [
    ...builtins,
    ...extensions.map((contribution) => ({
      id: contribution.kind,
      label: contribution.title,
      icon: <ExtensionMark iconDataUrl={contribution.iconDataUrl} />,
      section: 'extensions' as const,
      onClick: () => onOpen(contribution.kind)
    }))
  ];
}

/**
 * Whether a heading belongs before this entry: it is the first of the extension
 * group. Derived from the entries themselves rather than kept as a second list,
 * so the drawn order and the keyboard order cannot disagree.
 *
 * Lives here, next to the entry builders, because this module is free of the
 * app-state graph — the drawing surface imports it, not the other way round.
 */
export function startsExtensionSection(
  entries: readonly WorkspacePanelAction[],
  index: number
): boolean {
  if (entries[index]?.section !== 'extensions') return false;
  return index === 0 || entries[index - 1]?.section !== 'extensions';
}
