import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Heart, HeartFilled, MessageCircle, Trash2 } from '@/lib/icons'
import type { MomentsPost } from '@gugu/core/shared/types/moments'
import { formatDate } from '@/i18n'
import { MomentAuthorProfile } from '../../components/discover/MomentAuthorProfile'
import { PostComments } from '../../components/discover/PostComments'
import { MediaGrid } from '../../components/media/MediaGrid'
import { Button } from '../../components/ui/Button'
import { deleteMomentPost, togglePostLike } from '../../lib/moments'
import { PlazaPostBody } from './PlazaPostBody'

export function PlazaPostCard({
  post,
  commentsVersion,
  onRefresh,
}: {
  post: MomentsPost
  commentsVersion: number
  onRefresh: () => Promise<void>
}) {
  const { t } = useTranslation('discover')
  const [commentsExpanded, setCommentsExpanded] = useState(false)
  const [liking, setLiking] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const handleLike = useCallback(async () => {
    if (liking) return
    setLiking(true)
    setActionError(null)
    try {
      await togglePostLike(post.id, !post.likedByMe)
      await onRefresh()
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : t('moments.actionFailedFallback'))
    } finally {
      setLiking(false)
    }
  }, [liking, onRefresh, post.id, post.likedByMe, t])

  const handleDelete = useCallback(async () => {
    if (deleting || !window.confirm(t('moments.deleteConfirm'))) return
    setDeleting(true)
    setActionError(null)
    try {
      await deleteMomentPost(post.id)
      await onRefresh()
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : t('moments.deleteFailedFallback'))
    } finally {
      setDeleting(false)
    }
  }, [deleting, onRefresh, post.id, t])

  return (
    <article className="gg-pcard" data-testid="plaza-post-card">
      <header className="gg-pcard-head">
        <MomentAuthorProfile author={post.author} />
        <time className="gg-pdate" dateTime={post.createdAt}>
          {formatDate(post.createdAt, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </time>
      </header>

      {post.content ? <PlazaPostBody post={post} /> : null}
      <MediaGrid
        className="gg-pmedia"
        images={post.media.map((media, index) => ({
          url: media.url,
          alt: t('moments.postImage', { name: post.author.name, number: index + 1 }),
        }))}
      />

      <div className="gg-pactions">
        <Button
          variant="ghost"
          size="sm"
          className={`gg-paction${post.likedByMe ? ' gg-paction-active' : ''}`}
          aria-pressed={post.likedByMe}
          disabled={liking || deleting}
          onClick={() => { void handleLike() }}
        >
          {/* 线性/Bold 两个字形,❌ 不是 fill= 切换:Solar body 里 fill="none" 写死在 path 上,
              外层 svg 的 fill 覆盖不了它(整条链路会静默保持空心)。 */}
          {post.likedByMe ? <HeartFilled size={17} /> : <Heart size={17} />}
          {t('moments.likeCount', { count: post.likeCount })}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="gg-paction"
          aria-expanded={commentsExpanded}
          onClick={() => setCommentsExpanded((value) => !value)}
        >
          <MessageCircle size={17} />
          {post.commentCount > 0
            ? t('comments.count', { count: post.commentCount })
            : t('comments.label')}
        </Button>
        {post.isMine ? (
          <Button
            variant="ghost"
            size="icon"
            className="gg-paction gg-pdelete"
            aria-label={t('moments.delete')}
            title={t('moments.delete')}
            disabled={deleting || liking}
            onClick={() => { void handleDelete() }}
          >
            <Trash2 size={17} />
          </Button>
        ) : null}
      </div>
      {actionError ? <div className="gg-paction-error" role="alert">{actionError}</div> : null}

      <PostComments
        postId={post.id}
        expanded={commentsExpanded}
        refreshToken={commentsVersion}
        onChanged={onRefresh}
      />
    </article>
  )
}
