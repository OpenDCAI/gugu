import { nativeChatAppearance } from './native-chat-appearance.css';
import { ChatComposer } from '@gugu/session-ui/react/components';
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChatTranscript, type ChatTranscriptProps } from './chat-transcript';

/** Every agent conversation uses the project page's transcript and composer. Hosts own data and navigation. */
export type AgentConversationViewProps = ChatTranscriptProps & {
  composerContent?: ReactNode;
  shown?: boolean;
  onVisibleItems?: (ids: readonly string[]) => void;
};

export function AgentConversationView({ layout, composerContent, shown = true, onVisibleItems, style, className, onReady, ...props }: AgentConversationViewProps) {
  const root = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const host = root.current;
    if (!host || !shown || !onVisibleItems) return;
    let observing = true;
    let seen = new WeakSet<Element>();
    let observer: IntersectionObserver;
    const observe = () => host.querySelectorAll('[data-agent-conversation-message]').forEach(element => {
      if (!seen.has(element)) { seen.add(element); observer.observe(element); }
    });
    const resetObserver = () => {
      const rect = host.getBoundingClientRect();
      const bottom = slot ? Math.min(rect.bottom, slot.getBoundingClientRect().top) : rect.bottom;
      observer?.disconnect();
      seen = new WeakSet();
      observer = new IntersectionObserver(entries => {
        if (!observing || document.visibilityState === 'hidden') return;
        const viewport = host.getBoundingClientRect();
        const readableBottom = slot ? Math.min(viewport.bottom, slot.getBoundingClientRect().top) : viewport.bottom;
        const ids = entries.filter(entry => {
          if (!entry.isIntersecting || entry.intersectionRect.height <= 0) return false;
          // A message's header/actions can intersect while its body is behind the floating editor.
          const body = entry.target.querySelector('[data-user-card], [data-attachment-chip]') ?? entry.target;
          const content = body.getBoundingClientRect();
          return content.bottom > viewport.top && content.top < readableBottom;
        }).map(entry => entry.target.getAttribute('data-agent-conversation-message')).filter((id): id is string => !!id);
        if (ids.length) onVisibleItems(ids);
      }, { root: host, rootMargin: `0px 0px -${Math.max(0, rect.bottom - bottom)}px 0px` });
      observe();
    };
    resetObserver();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resetObserver);
    resize?.observe(host);
    if (slot) resize?.observe(slot);
    const mutations = new MutationObserver(records => {
      for (const record of records) if (record.type === 'attributes') { observer.unobserve(record.target as Element); observer.observe(record.target as Element); }
      observe();
    });
    mutations.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-agent-conversation-message'] });
    observe();
    const visibleAgain = () => {
      if (!observing || document.visibilityState === 'hidden') return;
      host.querySelectorAll('[data-agent-conversation-message]').forEach(element => { observer.unobserve(element); observer.observe(element); });
    };
    document.addEventListener('visibilitychange', visibleAgain);
    return () => { observing = false; document.removeEventListener('visibilitychange', visibleAgain); mutations.disconnect(); resize?.disconnect(); observer.disconnect(); };
  }, [shown, onVisibleItems, slot]);
  return <div ref={root} data-agent-conversation="" className={`${className ?? 'relative min-h-0 flex-1'} ${nativeChatAppearance}`} style={style}>
    <ChatTranscript stickToBottom pinUserMessages {...props}
      composer={composerContent ? 'slot' : props.composer}
      onReady={view => { setSlot(view.composerSlot); onReady?.(view); }}
      onDisposed={() => { setSlot(null); props.onDisposed?.(); }}
      layout={{ preset: 'double', userGutter: 0, ...layout, agentConversation: true }} style={{ position: 'absolute', inset: 0 }} />
    {slot && composerContent ? createPortal(composerContent, slot) : null}
  </div>;
}

export function AgentConversationComposer(props: ComponentProps<typeof ChatComposer>) {
  return <ChatComposer hideLockedAgent agentLocked {...props} />;
}
