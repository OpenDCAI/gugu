import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Reply, Trash2, X } from '@/lib/icons'
import type { MomentsComment } from '@gugu/core/shared/types/moments'
import { formatDate } from '@/i18n'
import {
  createMomentComment,
  deleteMomentComment,
  listPostComments,
  MomentsMediaRequiresReuploadError,
  uploadMomentsImage,
} from '../../lib/moments'
import type { MomentsUploadedMedia } from '../../lib/moments'
import { ImageAttachStrip } from '../media/ImageAttachStrip'
import { MediaGrid } from '../media/MediaGrid'
import { useImageAttachDraft } from '../media/useImageAttachDraft'
import { Button } from '../ui/Button'
import { MomentAuthorProfile } from './MomentAuthorProfile'
import { MomentLinkContent } from './MomentLinkContent'
import './PostComments.css'

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error'
type DraftAttempt = { id: string; media: MomentsUploadedMedia[] | null }

export function PostComments({
  postId,
  expanded,
  refreshToken,
  onChanged,
}: {
  postId: string
  expanded: boolean
  refreshToken: number
  onChanged: () => Promise<void>
}) {
  const { t } = useTranslation('discover')
  const [status, setStatus] = useState<LoadStatus>('idle')
  const [comments, setComments] = useState<MomentsComment[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [attempt, setAttempt] = useState<DraftAttempt | null>(null)
  const [replyTarget, setReplyTarget] = useState<MomentsComment | null>(null)
  const [posting, setPosting] = useState(false)
  const [composeError, setComposeError] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set())
  const requestSeq = useRef(0)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const imageDraft = useImageAttachDraft({ maxImages: 3 })

  const loadComments = useCallback(async () => {
    const seq = ++requestSeq.current
    setStatus('loading')
    setLoadError(null)
    try {
      const fetched = await listPostComments(postId)
      if (seq !== requestSeq.current) return
      setComments(fetched)
      setStatus('loaded')
    } catch (error: unknown) {
      if (seq !== requestSeq.current) return
      setLoadError(error instanceof Error ? error.message : t('comments.loadFailedFallback'))
      setStatus('error')
    }
  }, [postId, t])

  useEffect(() => {
    if (expanded) void loadComments()
  }, [expanded, loadComments])

  useEffect(() => {
    if (refreshToken > 0 && expanded && status !== 'idle') void loadComments()
    // refreshToken is the private-event-bus invalidation edge; status is intentionally read, not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, loadComments, refreshToken])

  const invalidateAttempt = useCallback(() => {
    setAttempt(null)
    setComposeError(null)
  }, [])

  const handleDraftChange = (nextDraft: string) => {
    if (nextDraft !== draft) invalidateAttempt()
    setDraft(nextDraft)
  }

  const handleAddFiles = (files: Iterable<File>) => {
    invalidateAttempt()
    imageDraft.addFiles(files)
  }

  const handleRemoveImage = (id: string) => {
    invalidateAttempt()
    imageDraft.removeImage(id)
  }

  const selectReply = (comment: MomentsComment) => {
    if (replyTarget?.id !== comment.id) invalidateAttempt()
    setReplyTarget(comment)
    inputRef.current?.focus()
  }

  const clearReply = useCallback(() => {
    if (replyTarget) invalidateAttempt()
    setReplyTarget(null)
  }, [invalidateAttempt, replyTarget])

  const handlePublish = useCallback(async () => {
    const content = draft.trim()
    if ((!content && imageDraft.images.length === 0) || posting) return
    setPosting(true)
    setComposeError(null)
    let currentAttempt = attempt
    try {
      const id = attempt?.id ?? crypto.randomUUID()
      const media = attempt?.media ?? await imageDraft.uploadImages(uploadMomentsImage)
      currentAttempt = { id, media }
      setAttempt(currentAttempt)
      await createMomentComment(postId, content, currentAttempt.id, {
        parentId: replyTarget?.id ?? null,
        media,
      })
      setDraft('')
      setAttempt(null)
      setReplyTarget(null)
      imageDraft.clearImages()
      await Promise.all([loadComments(), onChanged()])
    } catch (error: unknown) {
      if (error instanceof MomentsMediaRequiresReuploadError && currentAttempt) {
        setAttempt({ id: currentAttempt.id, media: null })
      }
      setComposeError(error instanceof Error ? error.message : t('comments.publishFailedFallback'))
    } finally {
      setPosting(false)
    }
  }, [attempt, draft, imageDraft, loadComments, onChanged, postId, posting, replyTarget?.id, t])

  const handleDelete = useCallback(async (comment: MomentsComment) => {
    if (deletingIds.has(comment.id) || !window.confirm(t('comments.deleteConfirm'))) return
    setDeletingIds((ids) => new Set(ids).add(comment.id))
    setMutationError(null)
    try {
      await deleteMomentComment(comment.id)
      if (replyTarget?.id === comment.id) clearReply()
      await Promise.all([loadComments(), onChanged()])
    } catch (error: unknown) {
      setMutationError(error instanceof Error ? error.message : t('comments.deleteFailedFallback'))
    } finally {
      setDeletingIds((ids) => {
        const next = new Set(ids)
        next.delete(comment.id)
        return next
      })
    }
  }, [clearReply, deletingIds, loadComments, onChanged, replyTarget?.id, t])

  if (!expanded) return null

  const canPublish = !posting && (draft.trim() !== '' || imageDraft.images.length > 0)

  return (
    <section className="gg-pcomments" aria-label={t('comments.regionLabel')}>
      {status === 'loading' ? (
        <div className="gg-pcomments-state gg-pcomments-loading" role="status">
          <span className="gg-pcomments-spinner" />
          {t('comments.loading')}
        </div>
      ) : null}
      {status === 'error' ? (
        <div className="gg-pcomments-state gg-pcomments-error" role="alert">
          <span>{t('comments.loadFailed', { error: loadError })}</span>
          <Button variant="ghost" size="sm" onClick={() => { void loadComments() }}>
            {t('comments.retry')}
          </Button>
        </div>
      ) : null}
      {status === 'loaded' && comments.length === 0 ? (
        <div className="gg-pcomments-state">{t('comments.empty')}</div>
      ) : null}
      {/* @@@comment-row-grid 评论行是「头像 | 名字·时间 / 正文」两行网格,不是「整行作者块 + 缩进正文」。
          旧结构让每条评论先占一条 44px 高的空作者行、正文再另起一行缩进 52px,一条单行评论要 110px+。
          作者块在这里 display:contents,头像跨两行占左栏,名字与时间共用第一行 —— 评论因此比正文更扁。 */}
      {status === 'loaded' && comments.length > 0 ? (
        <div className="gg-pcomment-list" data-testid="plaza-comments-list">
          {comments.map((comment) => (
            <article className="gg-pcomment" data-testid="plaza-comment" key={comment.id}>
              <MomentAuthorProfile author={comment.author} compact />
              <time className="gg-pcomment-time" dateTime={comment.createdAt}>
                {formatDate(comment.createdAt, {
                  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
                })}
              </time>
              <div className="gg-pcomment-main">
                {comment.replyToName ? (
                  <span className="gg-pcomment-replyto">{t('comments.replyTo', { name: comment.replyToName })}</span>
                ) : null}
                {comment.content ? <MomentLinkContent content={comment.content} className="gg-pcomment-text" /> : null}
                <MediaGrid
                  className="gg-pcomment-media"
                  images={comment.media.slice(0, 3).map((media, index) => ({
                    url: media.url,
                    alt: t('comments.imageAlt', { name: comment.author.name, number: index + 1 }),
                  }))}
                />
                <div className="gg-pcomment-row-actions">
                  <Button variant="ghost" size="sm" disabled={posting} onClick={() => selectReply(comment)}>
                    <Reply size={15} />
                    {t('comments.reply')}
                  </Button>
                  {comment.isMine ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('comments.delete')}
                      title={t('comments.delete')}
                      disabled={deletingIds.has(comment.id)}
                      onClick={() => { void handleDelete(comment) }}
                    >
                      <Trash2 size={15} />
                    </Button>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {mutationError ? <div className="gg-pcomment-compose-error" role="alert">{mutationError}</div> : null}
      {status === 'loaded' ? (
        <div className="gg-pcomment-compose">
          {replyTarget ? (
            <div className="gg-pcomment-replying">
              <span>{t('comments.replyingTo', { name: replyTarget.author.name })}</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('comments.cancelReply')}
                disabled={posting}
                onClick={clearReply}
              >
                <X size={15} />
              </Button>
            </div>
          ) : null}
          <textarea
            ref={inputRef}
            className="gg-pcomment-input"
            aria-label={t('comments.composeLabel')}
            value={draft}
            onChange={(event) => handleDraftChange(event.target.value)}
            placeholder={replyTarget
              ? t('comments.replyPlaceholder', { name: replyTarget.author.name })
              : t('comments.placeholder')}
            rows={2}
            disabled={posting}
          />
          <div className="gg-pcomment-attachments">
            <ImageAttachStrip
              images={imageDraft.images}
              onAddFiles={handleAddFiles}
              onRemove={handleRemoveImage}
              maxImages={3}
              disabled={posting}
            />
          </div>
          {composeError ? (
            <div className="gg-pcomment-compose-error" role="alert">
              {t('comments.publishFailed', { error: composeError })}
            </div>
          ) : null}
          <div className="gg-pcomment-actions">
            <Button
              variant="primary"
              size="sm"
              onClick={() => { void handlePublish() }}
              disabled={!canPublish}
            >
              {posting ? t('comments.publishing') : composeError ? t('comments.retry') : t('comments.publish')}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
