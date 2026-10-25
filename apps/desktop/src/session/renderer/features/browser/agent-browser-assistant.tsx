import { messageForUser } from '@/lib/userFacingError';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { toast } from 'sonner';
import { Pause, Play } from '@/lib/icons';
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
      log.error('[agent-browser-assistant] could not send a conversation shortcut', { sessionId: owner.sessionId, error });
      toast.error(messageForUser(error));
    } finally {
      setSending(false);
    }
  };
  return (
    <div
      data-testid="agent-browser-assistant" data-state={driving ? 'driving' : 'idle'}
      className="inline-flex h-10 items-center gap-3 rounded-full border border-border/60 bg-background pl-3 pr-1 text-xs font-normal text-foreground shadow-sm">
      <span className="flex min-w-0 items-center gap-2">
        <span aria-hidden className={driving ? 'size-1.5 shrink-0 rounded-full bg-foreground-success' : 'size-1.5 shrink-0 rounded-full border border-foreground-muted'} />
        <span className="max-w-80 truncate">{driving ? translate('browser.assistantOperatingIdentity', { name: agentName }) : agentName}</span>
      </span>
      <Button type="button" size="sm" disabled={sending}
        className="h-8 gap-2 rounded-full px-3 text-xs font-medium"
        aria-label={translate(driving ? 'browser.assistantPauseHint' : 'browser.assistantContinueHint', { name: agentName })}
        title={translate(driving ? 'browser.assistantPauseHint' : 'browser.assistantContinueHint', { name: agentName })}
        onClick={() => void send(driving ? 'pause' : 'continue')}>
        {driving ? <Pause aria-hidden className="size-3.5" /> : <Play aria-hidden className="size-3.5" />}
        {translate(driving ? 'browser.assistantPauseAction' : 'browser.assistantContinueAction')}
      </Button>
    </div>
  );
});
