import { useCallback } from 'react';
import type { ViewId, WrapParams } from '@renderer/app/view-registry';
import { appState } from '@renderer/lib/stores/app-state';

export type NavArgs<TId extends ViewId> = keyof WrapParams<TId> extends never
  ? [viewId: TId]
  : Partial<WrapParams<TId>> extends WrapParams<TId>
    ? [viewId: TId, params?: WrapParams<TId>]
    : [viewId: TId, params: WrapParams<TId>];

export type NavigateFnTyped = <TId extends ViewId>(...args: NavArgs<TId>) => void;

export function useNavigate(): { navigate: NavigateFnTyped } {
  const navigate = useCallback((...args: unknown[]) => {
    const [viewId, params] = args as [ViewId, WrapParams<ViewId> | undefined];
    appState.navigation.navigate(viewId, params);
  }, []) as NavigateFnTyped;
  return { navigate };
}
