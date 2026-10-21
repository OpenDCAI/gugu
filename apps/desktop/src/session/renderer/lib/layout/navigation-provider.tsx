import { useObserver } from 'mobx-react-lite';
import { Fragment, useCallback, type ComponentType, type ReactNode } from 'react';
import type { ViewDefinition, ViewId, WrapParams } from '@renderer/app/view-registry';
import { registeredViews } from './registered-views';
import { appState } from '@renderer/lib/stores/app-state';
export { useNavigate, type NavigateFnTyped, type NavArgs } from './navigation-actions';

/**
 * NavArgs makes the params argument optional when all fields are optional,
 * and omits it entirely for views with no params (home, skills).
 */
export type UpdateViewParamsFn = <TId extends ViewId>(
  viewId: TId,
  update: Partial<WrapParams<TId>> | ((prev: WrapParams<TId>) => WrapParams<TId>)
) => void;

export type SlotsContextValue = {
  WrapView: ComponentType<{ children: ReactNode } & Record<string, unknown>>;
  TitlebarSlot: ComponentType;
  MainPanel: ComponentType;
  currentView: ViewId;
  withoutSessionSidebar: boolean;
};

export type WrapParamsContextValue = {
  wrapParams: Record<string, unknown>;
};

export type ViewParamsStoreContextValue = {
  viewParamsStore: Partial<{ [K in ViewId]: WrapParams<K> }>;
};

export function useWorkspaceSlots(): SlotsContextValue {
  return useObserver(() => {
    const viewId = appState.navigation.currentViewId;
    const registry = registeredViews() as unknown as Record<string, ViewDefinition<Record<string, unknown>>>;
    const viewDef = registry[viewId];
    const def = viewDef ?? registry.home;
    const resolvedViewId = viewDef ? viewId : 'home';
    return {
      WrapView: (def.WrapView ?? Fragment) as ComponentType<
        { children: ReactNode } & Record<string, unknown>
      >,
      TitlebarSlot: def.TitlebarSlot ?? (() => null),
      MainPanel: def.MainPanel,
      currentView: resolvedViewId,
      withoutSessionSidebar: def.withoutSessionSidebar === true,
    };
  });
}

export function useWorkspaceWrapParams(): WrapParamsContextValue {
  return useObserver(() => ({
    wrapParams: (appState.navigation.viewParamsStore[appState.navigation.currentViewId] ??
      {}) as Record<string, unknown>,
  }));
}

export function useParams<TId extends ViewId>(
  viewId: TId
): {
  params: WrapParams<TId>;
  setParams: (
    update: Partial<WrapParams<TId>> | ((prev: WrapParams<TId>) => WrapParams<TId>)
  ) => void;
} {
  const setParams = useCallback(
    (update: Partial<WrapParams<TId>> | ((prev: WrapParams<TId>) => WrapParams<TId>)) => {
      appState.navigation.updateViewParams(viewId, update);
    },
    // viewId is a stable string literal
    [viewId]
  );
  return useObserver(() => ({
    params: (appState.navigation.viewParamsStore[viewId] ?? {}) as WrapParams<TId>,
    setParams,
  }));
}

export function isCurrentView(currentView: string | null | undefined, target: string): boolean {
  return currentView === target;
}
