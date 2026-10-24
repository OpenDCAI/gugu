import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/assistant-ui/ui/skeleton';
import { cn } from '@/lib/cn';
import { Button } from '@renderer/lib/ui/button';
import type { SessionTranslate } from '../extension-consent';
import { AppLifecycleButton, type AppLifecycle } from './app-lifecycle-button';
import type { ProductPageApi } from './app-product-page';
import { splitReadme } from './app-product-page';
import { ExtensionMonogram } from './extension-monogram';
import type { ExtensionPendingAction } from './extension-pending';

/**
 * A market feature uses its README's first image as complete artwork. App identity and
 * lifecycle controls sit below it; the image remains a keyboard-accessible detail entry.
 * Without artwork, the existing icon card supplies the title and description.
 * `card` uses the same image in the smaller 16:9 tiles on the newest shelf.
 */
export function AppFeaturedCard({
  variant = 'hero',
  hostKey,
  id,
  version,
  name,
  subtitle,
  body,
  meta,
  iconUrl,
  lifecycle,
  pending,
  pendingPercent,
  api,
  translate,
  onOpen,
  onAction,
}: {
  variant?: 'hero' | 'card';
  /** 哪台机器的市场(README 由那台机器答)。 */
  hostKey: string;
  id: string;
  version: string;
  name: string;
  subtitle: string;
  /** 大字下面那两行:简介里副标题以外的话。 */
  body: string;
  /** 名字下面那一小行:精选是「类别 · 发布方」,小卡是副标题。 */
  meta: string;
  iconUrl?: string | null;
  lifecycle: AppLifecycle;
  pending?: ExtensionPendingAction;
  pendingPercent?: number;
  api: Pick<ProductPageApi, 'marketReadme'>;
  translate: SessionTranslate;
  onOpen: () => void;
  onAction: () => void;
}) {
  // 底图跟着 README 走:一版的 README 不会变,所以按机器 + App + 版本记在查询缓存里。再进这一页时第一帧就是截图,
  // 不会每次先画图标版、等 README 取回来再换(owner 10-20「每次点进去 banner image 都要变一下」)。
  const { data: shot = null, isPending, isError, refetch } = useQuery({
    queryKey: ['market-readme-shot', hostKey, id, version],
    // 没读到就抛:失败不进缓存,下次进来再取(主进程那边已记日志)。
    queryFn: async () => {
      const result = await api.marketReadme({ extensionId: id, version });
      if (!result.success) throw new Error(result.error ?? 'featured App README unreadable');
      const artwork = result.data?.readme ? (splitReadme(result.data.readme).images[0] ?? null) : null;
      if (artwork) {
        const image = new window.Image();
        image.src = artwork.src;
        await image.decode();
      }
      return artwork;
    },
    staleTime: Infinity,
  });

  const card = variant === 'card';
  const artwork = isPending || isError || Boolean(shot);
  return (
    <div
      role="listitem"
      className={cn('mk-hero-card', card && 'is-card', artwork && 'has-shot')}
      data-testid={card ? `extension-card-${id}` : `app-featured-${id}`}
      onClick={onOpen}
    >
      <div className={cn('mk-hero-art', artwork ? 'is-shot' : 'is-icon')} aria-hidden={artwork ? undefined : true}>
        {isPending ? (
          <Skeleton className="absolute inset-0 rounded-none" role="status" aria-label={translate('extensions.loading')} aria-busy="true" />
        ) : isError ? (
          <div className="mk-status" role="alert">
            <span>{translate('extensions.loadFailed')}</span>
            <Button type="button" variant="ghost" size="sm" onClick={(event) => { event.stopPropagation(); void refetch(); }}>{translate('extensions.retry')}</Button>
          </div>
        ) : shot ? (
          <>
            <img src={shot.src} alt="" loading="lazy" decoding="async" />
            {!card ? (
              <button type="button" className="mk-hero-open" aria-label={translate('extensions.detailsOf', { name })} />
            ) : null}
          </>
        ) : (
          <>
            {iconUrl ? <img className="mk-hero-blur" src={iconUrl} alt="" /> : null}
            <span className="mk-icon mk-hero-big">
              <ExtensionMonogram name={name} iconDataUrl={iconUrl} />
            </span>
          </>
        )}
      </div>
      {card || artwork ? null : (
        <div className="mk-hero-text">
          <span className="mk-hero-label">{translate('extensions.featured')}</span>
          {/* 大字是一颗按钮:键盘也能进它的产品页(点了冒泡到外层那个 onClick)。 */}
          <button type="button" className="mk-hero-title" aria-label={translate('extensions.detailsOf', { name })}>
            {subtitle || name}
          </button>
          {body ? <p className="mk-hero-body">{body}</p> : null}
        </div>
      )}
      <div className="mk-hero-foot">
        <span className="mk-icon is-40">
          <ExtensionMonogram name={name} iconDataUrl={iconUrl} />
        </span>
        <span className="mk-hero-who">
          {/* 小卡上没有大字,名字就是进产品页的那颗按钮。 */}
          {card ? (
            <button type="button" className="mk-hero-name" aria-label={translate('extensions.detailsOf', { name })}>
              {name}
            </button>
          ) : (
            <b>{name}</b>
          )}
          <span>{meta}</span>
        </span>
        <AppLifecycleButton
          state={lifecycle}
          pending={pending}
          percent={pendingPercent}
          translate={translate}
          onClick={onAction}
          testId={card ? `market-row-action-${id}` : `app-featured-action-${id}`}
        />
      </div>
    </div>
  );
}
