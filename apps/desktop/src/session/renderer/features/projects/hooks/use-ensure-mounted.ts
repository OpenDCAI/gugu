import { useEffect } from 'react';
import {
  getProjectManagerStore,
  getProjectStore,
  projectViewKind,
} from '@renderer/features/projects/stores/project-selectors';
import { log } from '@renderer/utils/logger';

/**
 * 要用这几个项目了(页面要画它、新会话要建在它里面):还没挂上的经挂载的唯一入口挂上 ——
 * 别的机器上的项目列出时不挂(见 ProjectManagerStore.ensureMounted),那台机器此刻连不上就等它连上再挂。
 * 挂过失败的不在这里重试:那是错误面板上的「重试」。须在 observer 组件里调用(读的是项目的挂载状态)。
 */
export function useEnsureMounted(projectIds: readonly string[]): void {
  const waiting = [...new Set(projectIds)].filter((id) => projectViewKind(getProjectStore(id)) === 'idle_unmounted');
  const key = waiting.join('\n');
  useEffect(() => {
    if (!key) return;
    for (const projectId of key.split('\n')) {
      void getProjectManagerStore()
        .ensureMounted(projectId)
        .catch((error: unknown) => log.warn('[project-page] 挂载项目失败', { projectId, error }));
    }
  }, [key]);
}
