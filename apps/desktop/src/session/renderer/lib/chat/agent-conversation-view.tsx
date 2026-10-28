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
    const seen = new WeakSet<Element>();
    const observer = new IntersectionObserver(entries => {
      if (!observing || document.visibilityState === 'hidden') return;
      const ids = entries.filter(entry => entry.isIntersecting && entry.intersectionRect.height > 0)
        .map(entry => entry.target.getAttribute('data-agent-conversation-message')).filter((id): id is string => !!id);
      if (ids.length) onVisibleItems(ids);
    });
    const observe = () => host.querySelectorAll('[data-agent-conversation-message]').forEach(element => {
      if (!seen.has(element)) { seen.add(element); observer.observe(element); }
    });
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
    return () => { observing = false; document.removeEventListener('visibilitychange', visibleAgain); mutations.disconnect(); observer.disconnect(); };
  }, [shown, onVisibleItems]);
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
