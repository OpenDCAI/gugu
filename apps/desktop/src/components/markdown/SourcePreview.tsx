import { useLayoutEffect, useMemo, useRef } from 'react';
import { sourcePreview, mountSourcePreview } from '@gugu/session-chat-ui/source-preview';
import { sourcePreviewBody, sourcePreviewTwoLines } from '@gugu/session-chat-ui/source-preview-style';

/** Read-only opening of a source; its surrounding control owns the jump to the original. */
export function SourcePreview({ text, lines = 3 }: { text: string; lines?: 2 | 3 }) {
  const content = useMemo(() => sourcePreview(text), [text]);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => root.current ? mountSourcePreview(root.current, content.truncated) : undefined, [content]);
  return <div ref={root} className={`${sourcePreviewBody} ${lines === 2 ? sourcePreviewTwoLines : ''}`} data-conversation-source-markdown
    dangerouslySetInnerHTML={{ __html: content.html }} />;
}
