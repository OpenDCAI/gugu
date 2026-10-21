import { runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect, type ReactNode } from 'react';
import { appState } from '@renderer/lib/stores/app-state';

// 这里原先还有两段:开机时给焦点追踪器定初值、每次切视图把 project/task 写进「遥测作用域」。
// 两者都只为遥测服务,2026-09-10 遥测整套拆除时一并删掉。
export const WorkspaceViewProvider = observer(function WorkspaceViewProvider({
  children,
}: {
  children: ReactNode;
}) {
  const currentViewId = appState.navigation.currentViewId;

  useEffect(() => {
    runInAction(() => {
      appState.navigation.isNavigating = false;
    });
  }, [currentViewId]);

  return <>{children}</>;
});
