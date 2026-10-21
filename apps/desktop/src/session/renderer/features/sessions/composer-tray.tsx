import type { ReactNode } from 'react';
import { LibraryHostProvider, type LibraryHost } from '@renderer/features/library/library-host';
import {
  sessionComposerFrameLiftClassName,
  sessionComposerTrayClassName,
  sessionComposerTrayStyle
} from './session-composer-styles';

/**
 * 新建框上面那条托盘(项目 · 机器)+ 压住它下沿的新建框。新建会话页与项目页同一个
 * (owner 2026-09-25:项目页「也用 create task 的那个设计」)。
 * 通栏托盘:卡片比它宽、压住它下沿,只露顶上一条。两项左聚成一组:它们是同一句话
 * 「在哪个项目、哪台机器上跑」,连着扫。
 * ❌ 这里曾经还有第三项「分支」,已撤(owner 判):这里创建的会话直接跑在项目目录、不开 worktree
 * (runInProjectDir),分支既不是用户选的也不受它影响。要么它能真的决定跑在哪条分支上,要么就不渲染。
 * 第三项「文件夹」(#7341,项目页才有)是另一回事:它真的决定会话在这个项目的哪个文件夹里开工。
 */
export function ComposerTray({
  projectPicker,
  devicePicker,
  folderPicker = null,
  host,
  children,
}: {
  projectPicker: ReactNode;
  devicePicker: ReactNode;
  /** 项目页:这个项目里从哪个文件夹开工(#7341)。新建任务页没有。 */
  folderPicker?: ReactNode;
  /** 新建框的数据(agent、模型)问哪台机器。 */
  host: LibraryHost;
  children: ReactNode;
}) {
  return (
    <>
      <div className={sessionComposerTrayClassName} style={sessionComposerTrayStyle}>
        {projectPicker}
        {devicePicker}
        {folderPicker}
      </div>
      <div className={sessionComposerFrameLiftClassName}>
        <LibraryHostProvider value={host}>{children}</LibraryHostProvider>
      </div>
    </>
  );
}
