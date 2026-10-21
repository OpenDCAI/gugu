import React, { useCallback, useEffect, useState } from 'react';
import { Markdown, type MarkdownDensity } from '@/components/markdown/Markdown';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { ExpandableImage } from './expandable-image';

/**
 * The session page's markdown: the shared `<Markdown>` renderer bound to the session page's policies —
 * workspace links open in a tab, web links go through the confirm dialog, workspace images are
 * resolved through the host. Grammar, sanitizing and typography are the shared dialect's; nothing
 * here styles markdown.
 */
interface MarkdownRendererProps {
  content: string;
  density?: MarkdownDensity;
  className?: string;
  onOpenLink?: (href: string) => boolean | void;
  /** Files only: a leading `---` block is frontmatter. Free text (PR comments) must keep reading it as a rule. */
  frontmatter?: boolean;
  /** Resolves a non-web image source (e.g. workspace-relative) to a `data:` URI, or null for "not found". */
  resolveImage?: (src: string) => Promise<string | null>;
}

const ResolvedImage: React.FC<{
  src: string;
  alt: string;
  resolveImage: (src: string) => Promise<string | null>;
}> = ({ src, alt, resolveImage }) => {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    resolveImage(src)
      .then((result) => {
        if (cancelled) return;
        if (result) setDataUrl(result);
        else setError(true);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [src, resolveImage]);

  if (error) {
    return <span className="text-foreground-muted inline-block text-xs">[Image not found: {src}]</span>;
  }
  if (!dataUrl) {
    return <span className="text-foreground-muted inline-block text-xs">Loading image...</span>;
  }
  return <ExpandableImage src={dataUrl} alt={alt} className="max-w-full rounded-sm" />;
};

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  density = 'compact',
  className,
  frontmatter = false,
  resolveImage,
  onOpenLink,
}) => {
  const compact = density === 'compact';
  const openLink = useCallback(
    (href: string) => {
      if (onOpenLink?.(href)) return true;
      if (!/^https?:\/\//i.test(href)) return false;
      confirmOpenExternalLink(href);
      return true;
    },
    [onOpenLink]
  );
  const renderImage = useCallback(
    ({ src, alt }: { src?: string; alt: string }) => {
      if (src && resolveImage && !/^https?:\/\//i.test(src)) {
        return <ResolvedImage src={src} alt={alt} resolveImage={resolveImage} />;
      }
      // Compact bodies sit in cards (PR comments, extension notes): a tall image must not push the card open.
      return (
        <ExpandableImage
          src={src}
          alt={alt}
          className={compact ? 'h-auto max-h-80 max-w-full rounded-sm' : 'max-w-full rounded-sm'}
        />
      );
    },
    [resolveImage, compact]
  );

  return (
    <Markdown
      trust="document"
      density={density}
      frontmatter={frontmatter}
      content={content}
      onOpenLink={openLink}
      renderImage={renderImage}
      className={className}
    />
  );
};
