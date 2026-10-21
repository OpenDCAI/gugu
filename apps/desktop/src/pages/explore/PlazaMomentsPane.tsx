import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles } from '@/lib/icons'
import type { MomentsPost } from '@gugu/core/shared/types/moments'
import { ImageAttachStrip } from '../../components/media/ImageAttachStrip'
import { useImageAttachDraft } from '../../components/media/useImageAttachDraft'
import { PaneEmptyState } from '../../components/ui/PaneEmptyState'
import { Button } from '../../components/ui/Button'
import {
  createMomentPost,
  listFeedPosts,
  subscribeMoments,
  uploadMomentsImage,
} from '../../lib/moments'
import { discoverPaneClass } from './paneClass'
import { PlazaPostCard } from './PlazaPostCard'

/**
 * 广场 → 好友动态。发帖 + feed（moments RLS：仅自己/好友可见）。
 *
 * 发帖走「真落库后重新拉取」而不是乐观插入：这一条只有落库了才算数，
 * 先画上去再说会在失败时留下一条根本不存在的动态。
 */
export function PlazaMomentsPane({ active = true, panelId }: {
  /** 切到「找群」时本面板仍然挂载，只是隐藏，草稿和已拉到的动态不因切换子标签而丢失。 */
  active?: boolean
  panelId?: string
} = {}) {
  const { t } = useTranslation('discover')
  const [posts, setPosts] = useState<MomentsPost[]>([])
  const [postsLoaded, setPostsLoaded] = useState(false)
  const [postsError, setPostsError] = useState<string | null>(null)
  const [commentsVersion, setCommentsVersion] = useState(0)

  const [composeDraft, setComposeDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [composeError, setComposeError] = useState<string | null>(null)
  const imageDraft = useImageAttachDraft({ maxImages: 9 })

  // 三个触发点会并发：挂载/重试、写操作后的 canonical 重读、realtime 失效信号。
  // 慢请求可能后到并覆盖新数据，所以只认最后一次发起的那一次。
  const requestSeq = useRef(0)

  const loadPosts = useCallback(async (showLoading = true) => {
    const seq = ++requestSeq.current
    if (showLoading) setPostsLoaded(false)
    setPostsError(null)
    try {
      const next = await listFeedPosts()
      if (seq !== requestSeq.current) return
      setPosts(next)
    } catch (error: unknown) {
      if (seq !== requestSeq.current) return
      setPostsError(error instanceof Error ? error.message : t('moments.loadFailedFallback'))
    } finally {
      if (seq === requestSeq.current) setPostsLoaded(true)
    }
  }, [t])

  useEffect(() => { void loadPosts() }, [loadPosts])

  useEffect(() => {
    if (!active) return
    const refreshPosts = () => { void loadPosts(false) }
    const refreshComments = () => {
      setCommentsVersion((version) => version + 1)
      void loadPosts(false)
    }
    return subscribeMoments({
      onPostsChange: refreshPosts,
      onLikesChange: refreshPosts,
      onCommentsChange: refreshComments,
    })
  }, [active, loadPosts])

  const handlePublish = useCallback(async () => {
    const content = composeDraft.trim()
    if ((!content && imageDraft.images.length === 0) || posting) return
    setPosting(true)
    setComposeError(null)
    try {
      const media = await imageDraft.uploadImages(uploadMomentsImage)
      await createMomentPost(content, media)
      setComposeDraft('')
      imageDraft.clearImages()
      await loadPosts(false)
    } catch (error: unknown) {
      setComposeError(error instanceof Error ? error.message : t('moments.publishFailedFallback'))
    } finally {
      setPosting(false)
    }
  }, [composeDraft, imageDraft, loadPosts, posting, t])

  const canPublish = !posting && (composeDraft.trim() !== '' || imageDraft.images.length > 0)
  const refreshFeed = useCallback(() => loadPosts(false), [loadPosts])

  return (
    <div className={discoverPaneClass(active)} id={panelId} role="tabpanel" tabIndex={-1} data-dpane="mo">
      <div className="gg-moments-shell">
        <div className="gg-compose">
          <textarea
            aria-label={t('moments.composeLabel')}
            className="gg-compose-input"
            value={composeDraft}
            onChange={(event) => {
              setComposeDraft(event.target.value)
              setComposeError(null)
            }}
            placeholder={t('moments.placeholder')}
            rows={3}
            disabled={posting}
          />
          <div className="gg-compose-attachments">
            <ImageAttachStrip
              images={imageDraft.images}
              onAddFiles={imageDraft.addFiles}
              onRemove={imageDraft.removeImage}
              maxImages={9}
              disabled={posting}
            />
          </div>
          {composeError ? <div className="gg-compose-error" role="alert">{composeError}</div> : null}
          <div className="gg-compose-actions">
            <span className="gg-compose-privacy">{t('moments.privacy')}</span>
            <Button
              variant="primary"
              size="sm"
              className="gg-compose-btn"
              onClick={() => { void handlePublish() }}
              disabled={!canPublish}
            >
              {posting ? t('moments.publishing') : t('moments.publish')}
            </Button>
          </div>
        </div>

        <div className="gg-plaza" data-testid="plaza-feed">
          {!postsLoaded ? <div className="gg-spinner" role="status" aria-label={t('moments.loading')} /> : null}
          {postsLoaded && postsError ? (
            <div className="gg-pane-status" role="alert">
              {t('moments.loadFailed', { error: postsError })}
              <Button variant="ghost" size="sm" onClick={() => { void loadPosts() }}>
                {t('moments.retry')}
              </Button>
            </div>
          ) : null}
          {postsLoaded && !postsError && posts.length === 0 ? (
            <div className="gg-pane-empty-wrap">
              <PaneEmptyState
                icon={<Sparkles size={26} color="var(--text-tertiary)" />}
                caption={t('moments.empty')}
                hint={t('moments.emptyHint')}
              />
            </div>
          ) : null}
          {postsLoaded && !postsError ? posts.map((post) => (
            <PlazaPostCard
              key={post.id}
              post={post}
              commentsVersion={commentsVersion}
              onRefresh={refreshFeed}
            />
          )) : null}
        </div>
      </div>
    </div>
  )
}
