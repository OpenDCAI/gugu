import { useEffect, useRef, useState } from 'react';
import { PREVIEW_LINK_MESSAGE_TYPE, PREVIEW_SCROLL_MESSAGE_TYPE, PREVIEW_RESTORE_MESSAGE_TYPE, PREVIEW_RESTORED_MESSAGE_TYPE } from '@/session/shared/preview/preview-link-script';

/** Keep the last page painted until its replacement has loaded and restored its scroll. */
export function HtmlPreviewSurface({ fileName, url, onLink, scrollPosition }: { fileName: string; url: string; onLink: (href: string) => void; scrollPosition?: { x: number; y: number } }) {
  const [visible, setVisible] = useState(url);
  const [loaded, setLoaded] = useState<{ frame: HTMLIFrameElement }>();
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const localScroll = useRef({ x: 0, y: 0 });
  const scroll = scrollPosition ?? localScroll.current;
  // A load's fallback belongs to its URL, not to the current link callback.
  useEffect(() => {
    if (loaded?.frame !== frames.current.get(url) || visible === url) return;
    const timer = setTimeout(() => setVisible(url), 500);
    return () => clearTimeout(timer);
  }, [loaded, url, visible]);
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const source = [...frames.current].find(([, frame]) => frame.contentWindow === event.source)?.[0];
      if (!source) return;
      const data = event.data as { type?: string; href?: string; x?: number; y?: number } | null;
      if (data?.type === PREVIEW_LINK_MESSAGE_TYPE && source === visible && typeof data.href === 'string') onLink(data.href);
      if (data?.type === PREVIEW_SCROLL_MESSAGE_TYPE && source === visible && Number.isFinite(data.x) && Number.isFinite(data.y)) {
        scroll.x = Math.max(0, data.x!);
        scroll.y = Math.max(0, data.y!);
      }
      if (data?.type === PREVIEW_RESTORED_MESSAGE_TYPE && source === url) {
        setVisible(url);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [url, visible, onLink, scroll]);
  return (
    <div className="relative min-h-0 flex-1">
      {[...new Set([visible, url])].map(source => (
        <iframe
          key={source}
          ref={frame => { if (frame) frames.current.set(source, frame); else frames.current.delete(source); }}
          title={fileName}
          src={source}
          // Keep the existing opaque sandbox; scroll/link messages never grant same-origin access.
          sandbox="allow-scripts"
          className={`absolute inset-0 h-full w-full border-0 bg-[var(--bg-primary)] ${source === visible ? 'visible' : 'invisible'}`}
          onLoad={(event) => {
            if (source !== url) return;
            frames.current.get(source)?.contentWindow?.postMessage({ type: PREVIEW_RESTORE_MESSAGE_TYPE, ...scroll }, '*');
            // A page's own CSP can block the injected script. Still reveal that page after load.
            setLoaded({ frame: event.currentTarget });
          }}
        />
      ))}
    </div>
  );
}
