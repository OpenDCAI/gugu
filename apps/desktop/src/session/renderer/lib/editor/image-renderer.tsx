import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { usePinchZoom, type PinchPoint } from '@/hooks/usePinchZoom';
import { ContainedImage } from '@renderer/lib/ui/contained-image';
import {
  anchorScrollDelta,
  clampZoom,
  imageFitScale,
  imageMaxScale,
  pinchZoom,
  pointerFraction,
} from '@shared/preview/pinch-zoom';

interface ImageRendererProps {
  file: { path: string; content: string };
}

type Size = { width: number; height: number };

/** 缩放前记下的锚:指针在屏幕上的位置,和它落在图片上的相对位置(0..1)。 */
type ZoomAnchor = { clientX: number; clientY: number; fractionX: number; fractionY: number };

/** 与外层 `p-4` 一致:算「适合窗格」时要扣掉这圈留白。 */
const VIEWPORT_PADDING_PX = 16;

/**
 * Renders raster image files (png, jpg, gif, webp, ico, bmp).
 *
 * 默认「适合窗格」(整张装进去,只缩不放)。双指捏合以指针为锚放大/缩小,双击在「适合窗格」与
 * 放大之间切换(#6456)。放大后超出窗格的部分用原生滚动看 —— 普通双指滑动照常滚动,不被吞掉。
 * ❌ 缩放整个界面:只缩放这张图(#669)。
 */
export function ImageRenderer({ file }: ImageRendererProps) {
  const fileName = file.path.split('/').pop() ?? file.path;
  const viewportRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  // 两样都按图片来源记:换了一张图,上一张的原始尺寸和缩放就不算数了。
  const [loaded, setLoaded] = useState<{ src: string; size: Size } | null>(null);
  const [pinned, setPinned] = useState<{ src: string; scale: number } | null>(null);
  const anchorRef = useRef<ZoomAnchor | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () =>
      setBox({
        width: Math.max(0, viewport.clientWidth - VIEWPORT_PADDING_PX * 2),
        height: Math.max(0, viewport.clientHeight - VIEWPORT_PADDING_PX * 2),
      });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const natural = loaded?.src === file.content ? loaded.size : null;
  const fitScale = natural ? imageFitScale(natural, box) : 1;
  const maxScale = imageMaxScale(fitScale);
  // 没捏过就一直是「适合窗格」,跟着窗格大小走;捏过就钉在那个比例上(仍落在当前的上下限里)。
  const scale =
    pinned?.src === file.content ? clampZoom(pinned.scale, fitScale, maxScale) : fitScale;

  const zoomTo = (next: number, point: PinchPoint) => {
    const viewport = viewportRef.current;
    const image = viewport?.querySelector('img');
    if (!natural || !viewport || !image || next === scale) return;
    // 按图片实际画在哪记锚(见 `pointerFraction`):没铺满窗格的那一侧是居中的,留白会跟着变。
    const viewportRect = viewport.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();
    const clientX = viewportRect.left + point.x;
    const clientY = viewportRect.top + point.y;
    anchorRef.current = {
      clientX,
      clientY,
      fractionX: pointerFraction(clientX, imageRect.left, imageRect.width),
      fractionY: pointerFraction(clientY, imageRect.top, imageRect.height),
    };
    // 回到适合窗格就不再钉比例:之后拖动窗格,图照旧跟着窗格走。
    setPinned(next === fitScale ? null : { src: file.content, scale: next });
  };

  usePinchZoom(viewportRef, (deltaY, point) => {
    zoomTo(pinchZoom(scale, deltaY, fitScale, maxScale), point);
  });

  // 比例一变,量一次图片新画在哪,把图片上同一点滚回指针下。
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const image = viewport?.querySelector('img');
    const anchor = anchorRef.current;
    if (!viewport || !image || !anchor) return;
    anchorRef.current = null;
    const rect = image.getBoundingClientRect();
    viewport.scrollLeft += anchorScrollDelta(rect.left, rect.width, anchor.fractionX, anchor.clientX);
    viewport.scrollTop += anchorScrollDelta(rect.top, rect.height, anchor.fractionY, anchor.clientY);
  }, [scale]);

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport || !natural) return;
    const rect = viewport.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    // 放大着就回到适合窗格;适合窗格时放到原图 100%(本来就是原大的小图放到 2 倍)。
    zoomTo(scale > fitScale ? fitScale : clampZoom(Math.max(1, fitScale * 2), fitScale, maxScale), point);
  };

  return (
    <div ref={viewportRef} className="h-full overflow-auto" onDoubleClick={onDoubleClick}>
      {/* 量到原图尺寸之前照旧用 CSS 装进窗格,❌ 先按原大画一帧再缩回来。 */}
      <div
        className={
          natural
            ? 'flex min-h-full w-max min-w-full items-center justify-center p-4'
            : 'flex h-full items-center justify-center p-4'
        }
      >
        <ContainedImage
          src={file.content}
          alt={fileName}
          draggable={false}
          onLoad={(event) =>
            setLoaded({
              src: file.content,
              size: {
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              },
            })
          }
          className={natural ? 'max-w-none' : 'max-h-full max-w-full'}
          style={
            natural
              ? { width: natural.width * scale, height: natural.height * scale }
              : undefined
          }
        />
      </div>
    </div>
  );
}
