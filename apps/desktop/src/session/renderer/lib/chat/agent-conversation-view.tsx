import { connectDeliveredMessagePresentation, resolveDeliveredAttachment } from './delivered-message-presentation';
import { rendererLogger } from '@/lib/log';
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
    if (!props.state?.session?.setDeliveredMessages) return;
    return connectDeliveredMessagePresentation(props.state, async id => {
      const [{ chatService }, { getCurrentAuthUserId }] = await Promise.all([import('@/lib/chat'), import('@/lib/supabase')]);
      return chatService.getMessageById(id, await getCurrentAuthUserId());
    }, (messageId, error) => rendererLogger('chat/delivery-presentation').warn({ messageId, error }, 'Could not load original attachment message'));
  }, [props.state]);
  useEffect(() => {
    const host = root.current;
    if (!host || !shown || !onVisibleItems) return;
    let observing = true;
    let seen = new WeakSet<Element>();
    let observer: IntersectionObserver;
    let frame = 0;
    const readable = (element: Element) => {
      const viewport = host.getBoundingClientRect();
      if (composerContent && (!slot || slot.getBoundingClientRect().height <= 0)) return false;
      const bottom = slot ? Math.min(viewport.bottom, slot.getBoundingClientRect().top) : viewport.bottom;
      const body = element.querySelector('[data-user-card], [data-attachment-chip]') ?? element;
      const content = body.getBoundingClientRect();
      // A covered short bubble has not been read. A reply taller than the
      // viewport becomes eligible when its end reaches the readable region.
      return content.width > 0 && content.height > 0 && content.bottom > viewport.top && content.bottom <= bottom
        && (content.top >= viewport.top || content.height > bottom - viewport.top)
        && content.right > viewport.left && content.left < viewport.right;
    };
    const report = (elements: readonly Element[]) => {
      if (!observing || document.visibilityState === 'hidden') return;
      const ids = elements.filter(readable).map(element => element.getAttribute('data-agent-conversation-message')).filter((id): id is string => !!id);
      if (ids.length) onVisibleItems(ids);
    };
    // A virtual row can already intersect before its anchored body is laid out.
    // Read again after layout changes, even if the person does not scroll.
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        report([...host.querySelectorAll('[data-agent-conversation-message]')]);
      });
    };
    const observe = () => host.querySelectorAll('[data-agent-conversation-message]').forEach(element => {
      if (!seen.has(element)) { seen.add(element); observer.observe(element); }
    });
    const resetObserver = () => {
      const rect = host.getBoundingClientRect();
      const bottom = slot ? Math.min(rect.bottom, slot.getBoundingClientRect().top) : rect.bottom;
      observer?.disconnect();
      seen = new WeakSet();
      observer = new IntersectionObserver(entries => {
        report(entries.filter(entry => entry.isIntersecting && entry.intersectionRect.height > 0).map(entry => entry.target));
      }, { root: host, rootMargin: `0px 0px -${Math.max(0, rect.bottom - bottom)}px 0px` });
      observe();
      schedule();
    };
    resetObserver();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resetObserver);
    resize?.observe(host);
    if (slot) resize?.observe(slot);
    const mutations = new MutationObserver(records => {
      for (const record of records) if (record.type === 'attributes' && (record.target as Element).hasAttribute('data-agent-conversation-message')) { observer.unobserve(record.target as Element); observer.observe(record.target as Element); }
      observe();
      schedule();
    });
    mutations.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-agent-conversation-message', 'style'] });
    observe();
    const visibleAgain = () => {
      if (!observing || document.visibilityState === 'hidden') return;
      host.querySelectorAll('[data-agent-conversation-message]').forEach(element => { observer.unobserve(element); observer.observe(element); });
      schedule();
    };
    document.addEventListener('visibilitychange', visibleAgain);
    host.addEventListener('scroll', schedule, true);
    return () => { observing = false; cancelAnimationFrame(frame); host.removeEventListener('scroll', schedule, true); document.removeEventListener('visibilitychange', visibleAgain); mutations.disconnect(); resize?.disconnect(); observer.disconnect(); };
  }, [shown, onVisibleItems, slot, !!composerContent]);
  return <div ref={root} data-agent-conversation="" className={`${className ?? 'relative min-h-0 flex-1'} ${nativeChatAppearance}`} style={style}>
    <ChatTranscript stickToBottom pinUserMessages {...props}
      composer={composerContent ? 'slot' : props.composer}
      commands={{ ...props.commands, resolveAttachment: attachment => attachment.id.startsWith('gugu-message-file://') ? resolveDeliveredAttachment(attachment.id) : props.commands?.resolveAttachment?.(attachment) ?? Promise.resolve(null) }}
      onReady={view => { setSlot(view.composerSlot); onReady?.(view); }}
      onDisposed={() => { setSlot(null); props.onDisposed?.(); }}
      layout={{ preset: 'double', userGutter: 0, ...layout, agentConversation: true }} style={{ position: 'absolute', inset: 0 }} />
    {slot && composerContent ? createPortal(composerContent, slot) : null}
  </div>;
}

export function AgentConversationComposer(props: ComponentProps<typeof ChatComposer>) {
  return <ChatComposer hideLockedAgent agentLocked {...props} />;
}
