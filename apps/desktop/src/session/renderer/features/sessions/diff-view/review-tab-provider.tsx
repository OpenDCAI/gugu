import { GitPullRequest } from 'lucide-react'
import { observer } from 'mobx-react-lite';
import type { ResolvedTab, TabBarItemProps, TabEntry, TabProvider, TabResource, TabViewContext } from '@renderer/features/tabs/core/tab-provider';
import { createTabProvider } from '@renderer/features/tabs/core/tab-provider-registry';
import { registeredTabView } from '@renderer/features/tabs/core/tab-views';
import { GenericTabDragPreview, GenericTabItem } from '@renderer/features/tabs/tab-bar/generic-tab-item';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

interface ReviewTabState {
  sessionId: string;
}

type ReviewTabOpenArgs = Record<string, never>;

class ReviewTabResource implements TabResource {
  dispose(): void {}
}

const ReviewTabBarItem = observer(function ReviewTabBarItem({
  tab,
  host,
  ctx,
}: TabBarItemProps<ReviewTabResource>) {
  const { translate } = useSessionMessages();
  return (
    <GenericTabItem
      tab={tab}
      host={host}
      ctx={ctx}
      label={translate('diff.reviewTab')}
      preSlot={<GitPullRequest className="size-3.5 shrink-0 text-foreground-muted" />}
    />
  );
});

function ReviewTabBarItemDragPreview({ tab: _tab }: { tab: ResolvedTab<ReviewTabResource> }) {
  const { translate } = useSessionMessages();
  return (
    <GenericTabDragPreview
      label={translate('diff.reviewTab')}
      preSlot={<GitPullRequest className="size-3.5 shrink-0 text-foreground-muted" />}
    />
  );
}

export const reviewTabProvider: TabProvider<
  'review',
  ReviewTabState,
  ReviewTabResource,
  ReviewTabOpenArgs
> = createTabProvider({
  kind: 'review',
  mount: 'single',
  resourceKey: (state) => state.sessionId,
  onBeforeOpen(_args: ReviewTabOpenArgs, ctx: TabViewContext): ReviewTabState {
    return { sessionId: ctx.viewId };
  },
  initialize(_entry: TabEntry<ReviewTabState>): ReviewTabResource {
    return new ReviewTabResource();
  },
  dispose(_entry: TabEntry<ReviewTabState>, resource: ReviewTabResource): void {
    resource.dispose();
  },
  TabBarItem: ReviewTabBarItem,
  TabBarItemDragPreview: ReviewTabBarItemDragPreview,
  TabContent: registeredTabView('review'),
});
