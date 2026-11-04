import { useEffect, useRef, useState } from 'react';
import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import { Skeleton } from '@/components/assistant-ui/ui/skeleton';
import { cn } from '@/lib/cn';
import { Button } from '@renderer/lib/ui/button';
import type { SessionTranslate } from '../extension-consent';
import { AppLifecycleButton, type AppLifecycle } from './app-lifecycle-button';
import type { ProductPageApi } from './app-product-page';
import { ExtensionMonogram } from './extension-monogram';
import { decodeShot, isDecoded, keepShot, keptShot, type Shot } from './kept-shelf';
import type { ExtensionPendingAction } from './extension-pending';
import { ResourceMenu } from '@/components/ResourceMenu';
import type { ResourceContext } from '@shared/resource-actions';

/** 首帧占位图的宽:几 KB 的 JPEG,data URL 首帧就画得出来;大图解码好了再换上。 */
const PLACEHOLDER_WIDTH = 48;

/**
 * 重启后第一帧那张大图还没解码:先画一张从它缩出来的小图(不用等解码,❌ 空着的深色框)。页面自己读不到下载站上图的字节
 * (不发 CORS 头,画进 canvas 也取不出像素),经 `marketRead` 读 —— 桌面是主进程,手机是原生壳,同一个形状。
 * 读不到(老版本的机器没有这一问、断网、不是下载站上的图)就没有占位图:❌ 重试,❌ 报错。
 */
async function placeholderOf(api: Pick<ProductPageApi, 'marketRead'>, src: string): Promise<string | undefined> {
  const pathname = new URL(src).pathname;
  const at = pathname.indexOf('/media/');
  if (!api.marketRead || at < 0) return undefined;
  try {
    const result = await api.marketRead({ path: decodeURIComponent(pathname.slice(at + 1)) });
    if (!result.success) return undefined;
    const bytes = Uint8Array.from(atob(result.data.base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const canvas = document.createElement('canvas');
    canvas.width = PLACEHOLDER_WIDTH;
    canvas.height = Math.max(1, Math.round((PLACEHOLDER_WIDTH * bitmap.height) / bitmap.width));
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return undefined;
  }
}

/**
 * 精选卡的底图:这一版产品页的第一张截图(`marketListing`),解码好了才算取到。一版的截图不会变,所以按机器 + App + 版本记在查询缓存里,
 * 这次运行里不丢(❌ 默认的 5 分钟回收:离开 Apps 一会儿再进来,又是骨架 + 重取,owner 10-30「既然曾经缓存过,为什么又要失效」),
 * 也留到下次启动(kept-shelf.ts)。
 */
export function featuredShotQuery(api: Pick<ProductPageApi, 'marketListing' | 'marketRead'>, hostKey: string, id: string, version: string) {
  return queryOptions({
    queryKey: ['market-listing-shot', hostKey, id, version],
    // 没读到就抛:失败不进缓存,下次再取(主进程那边已记日志)。
    queryFn: async () => {
      const result = await api.marketListing({ extensionId: id, version });
      if (!result.success) throw new Error(result.error);
      const artwork = { src: result.data.screenshots[0]! };
      await decodeShot(artwork.src);
      // 留到下次启动的那份带上占位图;缩图在后台,不挡这一次上屏。
      void placeholderOf(api, artwork.src).then((placeholder) => keepShot(hostKey, id, version, { ...artwork, placeholder }));
      return artwork as Shot;
    },
    // 重启后的第一帧:上次取到的这一版底图(下载站的地址是内容哈希的,图在 HTTP 缓存里),❌ 先画骨架再问一遍。
    initialData: () => keptShot(hostKey, id, version),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

/**
 * 画着一份精选时,换上新的那份之前先把它每张卡的底图取好、解码好:新精选 / 新一版整张换上,❌ 先换成骨架再出图。
 * 有一张取不到就抛:调用方留着画着的那份(下载站连不上时一直留着,❌ 换成空白)。
 */
export async function featuredShotsReady(
  client: QueryClient,
  api: Pick<ProductPageApi, 'marketListing' | 'marketRead'>,
  hostKey: string,
  featured: readonly { manifest: { id: string; version: string } }[]
): Promise<void> {
  await Promise.all(featured.map((item) => client.fetchQuery(featuredShotQuery(api, hostKey, item.manifest.id, item.manifest.version))));
}

/**
 * A market feature uses its listing's first screenshot as complete artwork. App identity and
 * lifecycle controls sit below it; the image remains a keyboard-accessible detail entry.
 * Without artwork, the icon card supplies the title.
 * `card` uses the same image in the smaller 16:9 tiles on the newest shelf.
 */
export function AppFeaturedCard({
  variant = 'hero',
  hostKey,
  id,
  version,
  name,
  subtitle,
  meta,
  iconUrl,
  lifecycle,
  pending,
  pendingPercent,
  api,
  translate,
  onOpen,
  onAction,
  resource,
}: {
  variant?: 'hero' | 'card';
  /** 哪台机器的市场(截图由那台机器答)。 */
  hostKey: string;
  id: string;
  version: string;
  name: string;
  subtitle: string;
  /** 名字下面那一小行:精选是「类别 · 发布方」,小卡是副标题。 */
  meta: string;
  iconUrl?: string | null;
  lifecycle: AppLifecycle;
  pending?: ExtensionPendingAction;
  pendingPercent?: number;
  api: Pick<ProductPageApi, 'marketListing' | 'marketRead'>;
  translate: SessionTranslate;
  onOpen: () => void;
  onAction: () => void;
  resource?: ResourceContext;
}) {
  // 取过的这一版底图一直在缓存里,换上的新一版清单读时已取好(featuredShotsReady):再进这一页、换上新一版,第一帧就是截图。
  const { data: shot = null, isPending, isError, refetch } = useQuery({ ...featuredShotQuery(api, hostKey, id, version), retryOnMount: false });
  // 上次存下的那张(重启后的 initialData)这次运行里还没解码:解码好再上屏;解不出来(图也读不到了)就重新取,走读不到的那张脸。
  const [, setDecodedSrc] = useState<string | null>(null);
  const shown = shot && isDecoded(shot.src);
  // 这张卡上画过图没有:挂上时就有解码好的图(再进来)就算画过。从骨架第一次换成图(全新安装、什么都没存)时,新的这个
  // `<img>` 自己也解码好了才露出来,之前骨架留着(❌ 先画一帧空的)。画过之后换新一版不再藏:浏览器在新图到手前留着旧的。
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [painted, setPainted] = useState(() => Boolean(shot && isDecoded(shot.src)));
  useEffect(() => {
    if (painted || !shown || shot?.placeholder) return;
    let alive = true;
    const done = () => alive && setPainted(true);
    void (imageRef.current?.decode() ?? Promise.resolve()).then(done, done);
    return () => {
      alive = false;
    };
  }, [painted, shown, shot]);
  const hidden = !painted && !shot?.placeholder;
  useEffect(() => {
    if (!shot || isDecoded(shot.src)) return;
    let alive = true;
    decodeShot(shot.src).then(
      () => alive && setDecodedSrc(shot.src),
      () => alive && void refetch()
    );
    return () => {
      alive = false;
    };
  }, [shot, refetch]);

  const card = variant === 'card';
  const artwork = isPending || isError || Boolean(shot);
  return (
    <ResourceMenu resource={resource ?? { kind: 'app', target: { kind: 'app-detail', extensionId: id } }}><div
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
            {/* 大图解码好之前画占位图(重启后的第一帧);连占位图都没有,骨架留着,❌ 画一张没解码完的大图。 */}
            <img
              ref={imageRef}
              src={shown || !shot.placeholder ? shot.src : shot.placeholder}
              alt=""
              style={hidden ? { visibility: 'hidden' } : undefined}
            />
            {hidden ? (
              <Skeleton className="absolute inset-0 rounded-none" role="status" aria-label={translate('extensions.loading')} aria-busy="true" />
            ) : null}
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
    </div></ResourceMenu>
  );
}
