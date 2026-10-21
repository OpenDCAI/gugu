import { useQuery } from '@tanstack/react-query';
import type { SessionTranslate } from '../extension-consent';
import { AppLifecycleButton, type AppLifecycle } from './app-lifecycle-button';
import type { ProductPageApi } from './app-product-page';
import { splitReadme } from './app-product-page';
import { ExtensionMonogram } from './extension-monogram';
import type { ExtensionPendingAction } from './extension-pending';

/**
 * 市场首页精选那一排里的一张(owner 10-19「参考 app store 首页」= App Store 的精选大卡):
 * 底图是它 README 里的第一张截图(截图铺右边,左边渐变出文字区);没有截图就用它的图标 —— 放大模糊当底,再放一个清晰的大图标。
 * 左上是「精选」、副标题(大字)和简介里剩下的话;底下一条是图标、名字、类别和那颗按钮。点卡片别处 = 它的产品页。
 * `card`:首页「最新」那一排的小卡(App Store 发现页里大图配一句话的卡):同一张底图在上(16:9),下面一条图标、名字、副标题和按钮。
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
  const { data: shot = null } = useQuery({
    queryKey: ['market-readme-shot', hostKey, id, version],
    // 没读到就抛:失败不进缓存,下次进来再取(主进程那边已记日志)。
    queryFn: async () => {
      const result = await api.marketReadme({ extensionId: id, version });
      if (!result.success) throw new Error(result.error ?? 'featured App README unreadable');
      return result.data?.readme ? (splitReadme(result.data.readme).images[0] ?? null) : null;
    },
    staleTime: Infinity,
  });

  const card = variant === 'card';
  return (
    <div role="listitem" className={card ? 'mk-hero-card is-card' : 'mk-hero-card'} data-testid={card ? `extension-card-${id}` : `app-featured-${id}`} onClick={onOpen}>
      <div className={shot ? 'mk-hero-art is-shot' : 'mk-hero-art is-icon'} aria-hidden>
        {shot ? (
          <img src={shot.src} alt="" loading="lazy" decoding="async" />
        ) : (
          <>
            {iconUrl ? <img className="mk-hero-blur" src={iconUrl} alt="" /> : null}
            <span className="mk-icon mk-hero-big">
              <ExtensionMonogram name={name} iconDataUrl={iconUrl} />
            </span>
          </>
        )}
      </div>
      {card ? null : (
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
