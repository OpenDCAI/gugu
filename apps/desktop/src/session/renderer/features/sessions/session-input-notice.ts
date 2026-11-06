import { useEffect, useRef } from 'react';
import { dismissNotice, notify, type Notice } from '@/lib/notices';
import { log } from '@renderer/utils/logger';

export type SessionInputNotice = Pick<Notice, 'title' | 'description' | 'tier' | 'action'> & {
  /** Diagnostic only: never forwarded to NoticeHost. */
  diagnostic?: unknown;
};

/** Lifetime bookkeeping for the existing outlet, shared by composers reading the same resource. */
export function createSessionInputNotices(outlet: {
  notify: (notice: Notice) => unknown;
  dismiss: (key: string) => void;
  diagnostic: (key: string, reason: unknown) => void;
}) {
  type Entry = { owners: Map<symbol, SessionInputNotice | null>; closed: boolean; shown?: string; diagnostic?: string };
  const entries = new Map<string, Entry>();
  function entry(key: string): Entry {
    let value = entries.get(key);
    if (!value) { value = { owners: new Map(), closed: false }; entries.set(key, value); }
    return value;
  }
  return {
    attach(key: string, owner: symbol) {
      entry(key).owners.set(owner, null);
      return () => {
        const value = entries.get(key);
        value?.owners.delete(owner);
        if (value && !value.owners.size) {
          outlet.dismiss(key);
          value.shown = undefined;
          // Unmounting is not recovery. Keep a dismissal across navigation/StrictMode.
        }
      };
    },
    update(key: string, owner: symbol, spec: SessionInputNotice | null | undefined) {
      if (spec === undefined) return; // A refresh in flight does not prove recovery.
      const value = entry(key);
      value.owners.set(owner, spec);
      if (!spec) {
        if ([...value.owners.values()].some(Boolean)) return;
        outlet.dismiss(key);
        entries.delete(key);
        return;
      }
      const diagnostic = JSON.stringify(spec.diagnostic);
      if (diagnostic !== undefined && diagnostic !== value.diagnostic) {
        value.diagnostic = diagnostic;
        outlet.diagnostic(key, spec.diagnostic);
      }
      const signature = JSON.stringify([spec.title, spec.description, spec.tier, spec.action?.label]);
      if (value.closed || value.shown === signature) return;
      value.shown = signature;
      outlet.notify({
        key, title: spec.title, description: spec.description, tier: spec.tier ?? 'error',
        // Resolve actions from the current publisher, not a stale render closure.
        action: spec.action && { label: spec.action.label, onClick: () => [...value.owners.values()].find(item => item?.action)?.action?.onClick() },
        ongoing: true,
        onDismiss: () => { value.closed = true; value.shown = undefined; },
      });
    },
  };
}

const notices = createSessionInputNotices({
  notify, dismiss: dismissNotice,
  diagnostic: (key, reason) => log.error('Session input failure', { key, reason }),
});

/** null = verified recovery; undefined = still reading; unmount only hides the notice. */
export function useSessionInputNotice(key: string, spec: SessionInputNotice | null | undefined): void {
  const owner = useRef(Symbol('session-input-notice'));
  useEffect(() => notices.attach(key, owner.current), [key]);
  useEffect(() => { notices.update(key, owner.current, spec); });
}
