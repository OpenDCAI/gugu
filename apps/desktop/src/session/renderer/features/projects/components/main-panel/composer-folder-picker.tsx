import { observer } from 'mobx-react-lite';
import { Check, ChevronDown, Folder, Plus } from '@/lib/icons';
import { sessionComposerTrayTriggerClassName } from '@renderer/features/sessions/session-composer-styles';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { ProjectFolder } from '@shared/core/projects/project-folders';
import { shortHome } from './project-folder-card';
import type { ProjectFoldersState, ShownFolder } from './project-folders';

function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * 项目页输入框托盘上的第三项:这个项目里从哪个文件夹开工(#7341)。与文件夹卡上点中的那一张是同一个选择,
 * 两处谁改了另一处都跟着变。菜单底部同样能「挂一个文件夹」。
 */
export const ComposerFolderPicker = observer(function ComposerFolderPicker({
  folders: state,
  onAttach,
  machineLabelOf,
  showMachine = false,
}: {
  folders: ProjectFoldersState;
  showMachine?: boolean;
  onAttach: () => void;
  /** 文件夹所在机器的名字(#7341 第二步);文件夹分在几台机器上时每一项都标出来,❌ 几个「项目根目录」分不清。 */
  machineLabelOf?: (deviceId: string | null) => string;
}) {
  const { translate } = useSessionMessages();
  const chosen = state.chosen;
  // 根目录常与项目同名:托盘上写「项目根目录」,❌ 写两遍项目名(「shop · 本机 · shop」)。
  const label = (folder: ProjectFolder) => (folder.kind === 'root' ? translate('projects.folders.root') : folderName(folder.path));
  // 读到之前 / 读不到时不画:❌ 拿一个猜的根目录名冒充选择(读不到的原因卡片上照实说了)。
  if (!state.folders || !chosen) return null;
  const spansMachines = showMachine || !!machineLabelOf && new Set(state.folders.map((folder) => machineLabelOf(folder.deviceId))).size > 1;
  const where = (folder: ShownFolder) => (spansMachines && machineLabelOf ? `${machineLabelOf(folder.deviceId)} · ${shortHome(folder.path)}` : shortHome(folder.path));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={sessionComposerTrayTriggerClassName} data-testid="composer-folder-picker" title={chosen.path}>
        <Folder className="size-3 shrink-0" />
        <span className="max-w-[240px] truncate">{showMachine && machineLabelOf ? `${machineLabelOf(chosen.deviceId)} · ` : ''}{label(chosen)}</span>
        <ChevronDown className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" className="min-w-72 p-1">
        {/* 分组标题只能在 Group 里(Base UI):少了这一层,点开菜单整页崩(#7341 实机撞过)。 */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>{translate('projects.folders.pickerTitle')}</DropdownMenuLabel>
          {state.folders.map((folder) => (
            <DropdownMenuItem key={folder.workspaceId} onClick={() => state.choose(folder.workspaceId)} title={folder.path}>
              <Folder className="size-3.5" />
              {/* 名字优先露全,路径是辅助:挤不下先截路径(❌「项目根...」配一整条路径)。 */}
              <span className="max-w-[60%] shrink-0 truncate">{label(folder)}</span>
              <small className="ml-auto min-w-0 flex-1 truncate pl-3 text-right text-foreground-passive">{where(folder)}</small>
              {folder.workspaceId === chosen.workspaceId ? <Check className="size-3.5 shrink-0" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onAttach} data-testid="composer-folder-attach">
          <Plus className="size-3.5" />
          <span>{translate('projects.folders.attach')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
