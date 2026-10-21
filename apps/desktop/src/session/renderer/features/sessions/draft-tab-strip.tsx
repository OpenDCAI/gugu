import { Folder, Globe, Plus, SquareTerminal } from '@/lib/icons';
import { ExtensionMark } from '@renderer/features/extensions/extension-mark';
import { TabStripShell } from '@renderer/features/tabs/tab-bar';
import { TabChip, TabSlot } from '@renderer/features/tabs/tab-bar/tab-chip';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/lib/ui/dropdown-menu';
import type { SessionMessageKey } from '@renderer/localization/messages';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { ExtensionTabKind } from '@shared/extensions/manifest';
import { TabBarActionRow } from './titlebar-actions';
import {
  type DraftBlocked,
  type DraftBuiltinTab,
  type DraftTab,
  draftWorkspaceEntries,
  isBuiltinDraftTab
} from './workspace-panel-entries';

const TAB_LABEL_KEYS = {
  terminal: 'workspace.terminal',
  browser: 'workspace.browser',
  files: 'workspace.files'
} as const satisfies Record<DraftBuiltinTab, SessionMessageKey>;

const TAB_ICONS: Record<DraftBuiltinTab, typeof Globe> = {
  terminal: SquareTerminal,
  browser: Globe,
  files: Folder
};

interface DraftTabStripProps {
  tabs: readonly DraftTab[];
  activeTab: DraftTab | null;
  selectedFileName: string | null;
  extensions: readonly {
    kind: ExtensionTabKind;
    title: string;
    iconDataUrl?: string | null;
    extensionId: string;
  }[];
  canOpenTerminal: boolean;
  canOpenFiles: boolean;
  blocked?: DraftBlocked;
  onSelect: (tab: DraftTab) => void;
  onClose: (tab: DraftTab) => void;
  onOpen: (tab: DraftTab) => void;
}

/**
 * 草稿工作区面板的页签条(新建会话页 / 项目首页)。
 *
 * 形状**不在这个文件里** —— 贴条走 <TabStripShell>、一枚页签走 <TabSlot> + <TabChip>,和会话页
 * 那条页签条同一份实现。这里只剩「草稿这边的页签是什么」:一个字符串,没有 ResolvedTab、没有
 * TabHost、不参与拖拽(草稿先于任务存在,引擎那套 pane/registry 还没有宿主)。
 *
 * ❌ 别再在这里另画一套形状。曾经这个文件自己写了 41px 带 + border-b + 四面圆角 chip,于是同一个
 * 产品里两套页签视觉:Chrome 式那版改完(#4095)这条没跟,owner 2026-09-21 实机一眼认出
 *「居然是老版本的 tab 样式」(#6107 C-04)。两份实现必然漂移,这是它唯一不会再漂的形态。
 *
 * 「+」现在住在滚动区里(<TabStripShell> 的 trailingSlot)。#4134 把它搬出滚动区,是因为当时草稿
 * 页签按**内容**撑开 —— 一个长文件名就能把整条 strip 撑过可视宽度,把「+」顶出去裁掉。共享的位
 * (平分 / 240 封顶 / 56 下限 / 标签截断)把那个成因根除了:一枚页签再也撑不开自己那一份。
 */
export function DraftTabStrip({
  tabs,
  activeTab,
  selectedFileName,
  extensions,
  canOpenTerminal,
  canOpenFiles,
  blocked,
  onSelect,
  onClose,
  onOpen
}: DraftTabStripProps) {
  const { translate } = useSessionMessages();

  return (
    <TabStripShell
      testId="draft-tab-strip"
      trailingSlot={
        <DraftAddMenu
          canOpenTerminal={canOpenTerminal}
          canOpenFiles={canOpenFiles}
          blocked={blocked}
          extensions={extensions}
          onOpen={onOpen}
        />
      }
      // 这条贴条的右端直抵窗口右缘,正压在固定簇(工作区面板开关)底下。一个动作都没有,但预留照留,
      // 且只认这一个出处 —— ❌ 曾经写死 pr-10(40px):它只是碰巧等于 mac 的预留,Windows/Linux 上
      // 少 138px,尾部的页签、它们的 ✕ 和「+」会钻到原生窗口控制条底下点不动。
      actionsSlot={<TabBarActionRow atWindowEdge />}
    >
      {tabs.map((tab) => {
        const builtin = isBuiltinDraftTab(tab);
        const extension = builtin ? null : extensions.find((entry) => entry.kind === tab);
        const label = !builtin
          ? extension?.title ?? tab
          : tab === 'files' && selectedFileName
            ? selectedFileName
            : translate(TAB_LABEL_KEYS[tab]);
        const Icon = builtin ? TAB_ICONS[tab] : null;
        return (
          <TabSlot key={tab} data-draft-tab={tab}>
            <TabChip
              isActive={activeTab === tab}
              label={label}
              preSlot={
                Icon ? (
                  <Icon className="size-3.5 shrink-0" />
                ) : (
                  <ExtensionMark iconDataUrl={extension?.iconDataUrl} />
                )
              }
              closeLabel={translate('task.closeTab', { label })}
              onClose={() => onClose(tab)}
              onClick={() => onSelect(tab)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onSelect(tab);
              }}
            />
          </TabSlot>
        );
      })}
    </TabStripShell>
  );
}

function DraftAddMenu({
  canOpenTerminal,
  canOpenFiles,
  blocked,
  extensions,
  onOpen
}: {
  canOpenTerminal: boolean;
  canOpenFiles: boolean;
  blocked?: DraftBlocked;
  extensions: readonly {
    kind: ExtensionTabKind;
    title: string;
    iconDataUrl?: string | null;
    extensionId: string;
  }[];
  onOpen: (tab: DraftTab) => void;
}) {
  const { translate } = useSessionMessages();
  const entries = draftWorkspaceEntries({
    canOpenTerminal,
    canOpenFiles,
    blocked,
    extensions,
    translate,
    onOpen
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            className="shrink-0"
            aria-label={translate('task.addPanel')}
          />
        }
      >
        <Plus className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {entries.map((entry) => (
          <DropdownMenuItem
            key={entry.id}
            disabled={entry.disabled}
            title={entry.title}
            onClick={entry.onClick}
          >
            {entry.icon} {entry.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
