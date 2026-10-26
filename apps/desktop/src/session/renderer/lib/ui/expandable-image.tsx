import { openImageFromThumb } from '@/lib/imageViewer';
import type React from 'react';
import { useRef } from 'react';
import { Button } from '@renderer/lib/ui/button';
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
      <Button
        type="button"
        variant="ghost"
        aria-label="Expand image"
        className="block h-auto max-w-full cursor-zoom-in border-0 bg-transparent p-0 hover:bg-transparent"
        onClick={openImage}
      >
        <ContainedImage
          ref={imageRef}
          src={src}
          alt={imageAlt}
          className={className}
          data-image-viewer-src={src}
          {...props}
        />
      </Button>
    </span>
  );
}
