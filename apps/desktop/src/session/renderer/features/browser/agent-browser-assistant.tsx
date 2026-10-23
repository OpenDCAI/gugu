import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { toast } from 'sonner';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import type { BrowserSessionIdentity } from '@shared/browser';
import { agentBrowserState } from './agent-browser-state';

/** Conversation shortcuts, not browser run controls. A click never predicts the Agent's response. */
export const AgentBrowserAssistant = observer(function AgentBrowserAssistant({
  owner,
  agentName,
}: {
  owner: BrowserSessionIdentity;
  agentName: string;
}) {
  const { translate } = useSessionMessages();
  const [sending, setSending] = useState(false);
  const driving = agentBrowserState(owner.browserId) === 'driving';
  const send = async (request: 'pause' | 'continue') => {
    if (sending) return;
    setSending(true);
    try {
      const result = await rpc.sessions.sendMessage({
        projectId: owner.projectId,
        sessionId: owner.sessionId,
        clientMessageId: crypto.randomUUID(),
        text: translate(request === 'pause' ? 'browser.assistantPauseMessage' : 'browser.assistantContinueMessage'),
      });
      if (result.status === 'outcome-unknown') throw new Error('message delivery is unknown');
    } catch (error) {
      log.warn('[agent-browser-assistant] could not send a conversation shortcut', { sessionId: owner.sessionId, error });
      toast.error(translate('browser.assistantMessageFailed'));
    } finally {
      setSending(false);
    }
  };
  return (
    <Button type="button" variant="ghost" size="sm" disabled={sending}
      data-testid="agent-browser-assistant" data-state={driving ? 'driving' : 'idle'}
      className="h-8 gap-2 rounded-full border border-border/60 bg-background px-3 text-xs font-normal text-foreground shadow-sm hover:bg-background-secondary-2"
      title={translate(driving ? 'browser.assistantPauseHint' : 'browser.assistantContinueHint', { name: agentName })}
      onClick={() => void send(driving ? 'pause' : 'continue')}>
      <span aria-hidden className={driving ? 'size-1.5 shrink-0 rounded-full bg-foreground-success' : 'size-1.5 shrink-0 rounded-full border border-foreground-muted'} />
      <span className="max-w-80 truncate">{translate(driving ? 'browser.assistantOperatingShortcut' : 'browser.assistantContinueShortcut', { name: agentName })}</span>
    </Button>
  );
});
