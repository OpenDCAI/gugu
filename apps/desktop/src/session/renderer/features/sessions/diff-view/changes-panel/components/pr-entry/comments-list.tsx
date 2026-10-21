import { ExternalLink, MessageSquare } from '@/lib/icons'
import { useMemo } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import { cn } from '@renderer/utils/utils';
import {
  sortPullRequestSessionItems,
  type PullRequestSessionItem,
} from './pull-request-session';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

function commentAuthorLabel(comment: PullRequestSessionItem): string {
  return comment.author?.displayName ?? comment.author?.userName ?? 'Unknown author';
}

function commentLocationLabel(comment: PullRequestSessionItem): string | null {
  if (!comment.path) return null;
  return comment.line ? `${comment.path}:${comment.line}` : comment.path;
}

function isBotAuthor(comment: PullRequestSessionItem): boolean {
  return comment.author?.userName.endsWith('[bot]') ?? false;
}

function CommentItem({ comment }: { comment: PullRequestSessionItem }) {
  const { translate } = useSessionMessages();
  const location = commentLocationLabel(comment);
  const author = commentAuthorLabel(comment);
  const avatarRadiusClass = isBotAuthor(comment) ? 'rounded-sm' : 'rounded-full';

  return (
    <div className="group relative flex w-full min-w-0 gap-2 rounded-md px-3 py-2 text-left hover:bg-row-hover">
      {comment.author?.avatarUrl ? (
        <img
          src={comment.author.avatarUrl}
          alt={author}
          className={cn('mt-0.5 size-5 shrink-0', avatarRadiusClass)}
        />
      ) : (
        <div
          className={cn(
            'mt-0.5 flex size-5 shrink-0 items-center justify-center bg-background-2 text-foreground-muted',
            avatarRadiusClass
          )}
        >
          <MessageSquare className="size-3" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-foreground-muted">
          <span className="truncate font-medium text-foreground">{author}</span>
          <span className="shrink-0 text-foreground-passive">/</span>
          <RelativeTime compact value={comment.createdAt} className="shrink-0" />
          {comment.isResolved && (
            <>
              <span className="shrink-0 text-foreground-passive">/</span>
              <span className="shrink-0 text-foreground-passive">{translate('pr.resolved')}</span>
            </>
          )}
        </div>
        {location && (
          <div className="mt-0.5 truncate font-mono text-[length:var(--font-caption)] text-foreground-passive">
            {location}
          </div>
        )}
        <div
          className={cn(
            'mt-1 break-words text-xs leading-relaxed text-foreground-muted [&_*:last-child]:mb-0 [&_p]:mb-1.5',
            comment.isOutdated && 'text-foreground-passive'
          )}
        >
          <MarkdownRenderer content={comment.body} />
        </div>
      </div>
      <button
        className="absolute top-2 right-3 hidden items-center justify-center rounded-sm bg-background-1 px-1 py-0.5 text-foreground-muted group-hover:flex hover:text-foreground"
        onClick={() => void rpc.app.openExternal(comment.url)}
      >
        <ExternalLink className="size-3.5" />
      </button>
    </div>
  );
}

export function CommentsList({
  comments,
  isLoading,
  error,
}: {
  comments: PullRequestSessionItem[];
  isLoading?: boolean;
  error?: Error | null;
}) {
  const { translate } = useSessionMessages();
  const sorted = useMemo(() => [...comments].sort(sortPullRequestSessionItems), [comments]);

  if (isLoading && sorted.length === 0) {
    return <div className="px-3 py-2 text-xs text-foreground-passive">{translate('pr.loadingComments')}</div>;
  }

  if (error && sorted.length === 0) {
    return <div className="px-3 py-2 text-xs text-foreground-passive">{translate('pr.commentsFailed')}</div>;
  }

  if (sorted.length === 0) {
    return <div className="px-3 py-2 text-xs text-foreground-passive">{translate('pr.noComments')}</div>;
  }

  return (
    <div className="flex flex-col gap-[1px]">
      {sorted.map((comment) => (
        <CommentItem key={comment.id} comment={comment} />
      ))}
      {isLoading && (
        <div className="px-3 py-2 text-xs text-foreground-passive">{translate('pr.loadingComments')}</div>
      )}
      {error && (
        <div className="px-3 py-2 text-xs text-foreground-passive">{translate('pr.commentsFailed')}</div>
      )}
    </div>
  );
}
