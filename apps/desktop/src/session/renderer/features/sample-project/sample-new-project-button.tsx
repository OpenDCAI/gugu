import { AddProjectMenuItems } from '@renderer/features/sidebar/add-project-menu-items';
import { Button } from '@renderer/lib/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@renderer/lib/ui/dropdown-menu';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/** 「新建项目」:打开的是侧栏「添加项目」那一组(新建空白项目 / 使用现有文件夹 / 使用远程文件夹),同一组菜单项。 */
export function SampleNewProjectButton() {
  const { translate } = useSessionMessages();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" data-sample-new-project="">{translate('projects.sample.newProject')}</Button>} />
      <DropdownMenuContent className="min-w-48">
        <AddProjectMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
