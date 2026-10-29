import { ProjectCreationMenuItems } from '@renderer/features/projects/components/project-creation-menu-items';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { DropdownMenuGroup } from '@renderer/lib/ui/dropdown-menu';
import { RemoteProjectMenuItems } from './remote-project-menu-items';

/** 「添加项目」那一组(新建空白项目 / 使用现有文件夹 / 使用远程文件夹),建好就进这个项目。侧栏和示例项目(#709)用的是同一组。 */
export function AddProjectMenuItems() {
  const { navigate } = useNavigate();
  return (
    <DropdownMenuGroup>
      <ProjectCreationMenuItems onProjectReady={(projectId) => navigate('project', { projectId })} />
      <RemoteProjectMenuItems />
    </DropdownMenuGroup>
  );
}
