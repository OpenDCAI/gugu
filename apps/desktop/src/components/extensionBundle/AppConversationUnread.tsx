import { useEffect, useState, type ReactNode } from 'react';
import { observer } from 'mobx-react-lite';
import { useAuth } from '@/store/auth';
import { useChatStore } from '@/store/chatContext';
import { rendererLogger } from '@/lib/log';
import { rpc } from '@/session/renderer/lib/ipc';
import { installedExtensionsStore } from '@/session/renderer/features/extensions/installed-extensions-store';
import { conversationUnreadProjection } from '@/session/shared/extensions/unread-projection';
import type { StoredUnreadBinding } from '@/session/shared/extensions/unread-binding';

type Scope = { ownerId: string; inventory: object; bindings: Record<string, StoredUnreadBinding> };
type BindingRead = Promise<Awaited<ReturnType<typeof rpc.extensions.conversationUnreadBindings>>>;
const reads = new WeakMap<object, Map<string, BindingRead>>();
function read(ownerId: string, inventory: object) {
  // Sibling rail entries share one in-flight host read; no polling, counter cache or retry queue.
  let pending = reads.get(inventory);
  if (!pending) { pending = new Map(); reads.set(inventory, pending); }
  const key = ownerId;
  let request = pending.get(key);
  if (!request) {
    request = rpc.extensions.conversationUnreadBindings({ ownerId });
    pending.set(key, request);
    const shared = pending;
    void request.finally(() => { if (shared.get(key) === request) shared.delete(key); }).catch(() => {});
  }
  return request.then(result => ({ result, inventory }));
}

/** Mounted by the host rail, never by an App guest. Page lifetime does not participate. */
export const AppConversationUnread = observer(function AppConversationUnread({ extensionId, children }: {
  extensionId: string; children: (unread: boolean | null) => ReactNode;
}) {
  const { user } = useAuth();
  const ownerId = user?.id ?? null;
  const { chats } = useChatStore('chats');
  const inventory = installedExtensionsStore.manifests;
  const name = installedExtensionsStore.manifestFor(extensionId)?.contributes.unreadSource?.binding;
  const [scope, setScope] = useState<Scope | null>(null);
  useEffect(() => {
    if (!ownerId || !name) return;
    let disposed = false;
    // Synchronize the host-owned authorization association, not chat contents or a copied unread count.
    void read(ownerId, inventory).then(({ result }) => {
      if (disposed) return;
      if (!result.success || result.data.ownerId !== ownerId) throw new Error('Unread binding authority unavailable');
      setScope({ ownerId, inventory, bindings: result.data.bindings });
    }).catch(error => {
      if (!disposed) {
        setScope(null);
        rendererLogger('app-unread').warn({ error }, 'Could not verify App conversation unread bindings');
      }
    });
    return () => { disposed = true; };
  }, [ownerId, name, inventory]);
  const current = scope?.ownerId === ownerId && scope.inventory === inventory ? scope : null;
  const binding = current?.bindings[extensionId];
  return children(name ? conversationUnreadProjection({ ownerId, binding, name, chats }) : null);
});
