import { platform } from '@/platform';
import { rendererCommandEventName } from '@/lib/rendererCommandProtocol';
import { handleRendererRpcEvent } from '@/rpc-renderer/rendererRpc';
import { extensionHostActionHandlers } from './host-action-handlers';

/**
 * Connects the extension bridge's main half to the renderer half.
 *
 * Wired here rather than in the host `App`: the actions land on the tab strip
 * and the conversation, which live in the session page's module graph, and pulling
 * that graph into the host bundle is the thing `@shared/extensions/scheme.ts`
 * exists to avoid. Refs #2374.
 */

const DOMAIN = 'extensions' as const;

export function wireExtensionHostActions(): void {
  if (!platform.capabilities.rendererCommandBridge) return;

  window.addEventListener(rendererCommandEventName(DOMAIN), (event) => {
    void handleRendererRpcEvent(event, DOMAIN, extensionHostActionHandlers, (reqId, result) => {
      platform.sendRendererCommandResult(DOMAIN, reqId, result);
    });
  });
  platform.sendRendererCommandReady(DOMAIN);
}
