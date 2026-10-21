import { Expand } from '@/lib/icons'
import { openImageFromThumb } from '@/lib/imageViewer';
import type React from 'react';
import { useRef } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import { ContainedImage } from './contained-image';

type ExpandableImageProps = React.ComponentPropsWithoutRef<'img'> & {
  containerClassName?: string;
};

export function ExpandableImage({
  className,
  containerClassName,
  src,
  alt,
  ...props
}: ExpandableImageProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const imageAlt = alt ?? '';

  if (!src) {
    return <ContainedImage src={src} alt={imageAlt} className={className} {...props} />;
  }

  const openImage = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!imageRef.current) throw new Error('expandable image is not mounted');
    openImageFromThumb(imageRef.current);
  };

  return (
    <span
      className={cn('group/image relative inline-block max-w-full align-top', containerClassName)}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="secondary"
              size="icon-xs"
              aria-label="Expand image"
              className="absolute top-1 right-1 z-10 opacity-0 shadow-sm transition-opacity group-hover/image:opacity-100 focus-visible:opacity-100"
              onClick={openImage}
            >
              <Expand className="size-3" />
            </Button>
          }
        />
        <TooltipContent side="left" align="end">
          Expand image
        </TooltipContent>
      </Tooltip>
      <ContainedImage
        ref={imageRef}
        src={src}
        alt={imageAlt}
        className={className}
        data-image-viewer-src={src}
        {...props}
      />
    </span>
  );
}
